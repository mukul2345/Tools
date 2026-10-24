#!/usr/bin/env python3
"""
run_pipeline.py — the deterministic MR-review spine.

Inverts the control plane (docs/MR-REVIEW-ORCHESTRATION-AUDIT.md): this code driver owns the whole
sequence and every mechanical check; the LLM is invoked at exactly ONE node (semantic review),
grounded by the deterministic findings this spine produces.

Sequence (each step checkpoints a file; a re-run resumes at the first missing output):

    parse        MR URL -> ids                                    (mr_lib)
    fetch        MR meta / changed files / diffs / commits /      (gitlab_api, REST + PAT)
                 pipeline  -> mr.json, diffs/, changed-index.json
    submission   soft VPT gate                                    (submission_gate)
    clone        git clone @ source branch into the temp ws       (git + PAT clone url)
    build        pnpm install && pnpm build                       (shell)
    static       eslint/prettier/tsc + grep rules                 (review_static_gate)
    coverage     jest changed/related tests, no-regression vs base(coverage_gate)
    context      Jira + Confluence + cross-service MRs            (context_gather, Jira REST)
    input        assemble review-input.md for the LLM node        (this file)
    review       find -> verify -> (gap) over the whole change set (review_stages, headless
                 kiro-cli) -> per-MR review.md -> review_finalize -> post-plan.json
    post         deterministic posting of everything              (review_post, REST + PAT)
    cleanup      remove the temp clone                            (shell)

Several MR URLs = one CHANGE SET (e.g. one story across services): each MR is prepared in its own
workspace, the model stages see all of them (plus --related context-only MRs and the --seed
intent), and each MR gets its own comments. The model never posts; review_post.py does.

    ./run_pipeline.py <MR_URL> [<MR_URL> ...] [--seed TEXT | --seed-file F] [--related URL ...]
                       [--depth quick|standard|deep] [--force] [--from STEP]
                       [--no-agent] [--dry-run] [--no-post] [--keep]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import gitlab_api
import mr_lib
import review_stages
import run_record
import submission_gate as sg

HERE = Path(__file__).resolve().parent
WORKROOT = Path(os.environ.get("KIRO_MR_WORKROOT", "/tmp/kiro-mr-review"))


def log(msg: str) -> None:
    print(f"[spine] {msg}", flush=True)


def run(cmd: list[str], cwd: Path | None = None, check: bool = True, quiet_secrets: bool = False) -> subprocess.CompletedProcess:
    shown = "<redacted clone url>" if quiet_secrets else " ".join(cmd)
    log("$ " + shown)
    return subprocess.run(cmd, cwd=cwd, check=check)


def done(path: Path, force: bool) -> bool:
    if path.exists() and not force:
        log(f"skip — {path.name} present (checkpoint)")
        return True
    return False


# --------------------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------------------

def step_fetch(ref: mr_lib.MRRef, ws: Path, force: bool) -> dict:
    """Fetch MR data over REST and materialise diffs + changed-index to files."""
    mr_json = ws / "mr.json"
    if not done(mr_json, force):
        client = gitlab_api.GitLabClient.from_env(ref.host, ref.project_id)
        mr = client.get_merge_request(ref.mr_iid)
        diffs = client.list_changed_files(ref.mr_iid)
        commits = client.list_commits(ref.mr_iid)
        pipelines = client.list_pipelines(ref.mr_iid)

        mr_json.write_text(json.dumps(mr, indent=2))
        (ws / "mr-commits.json").write_text(json.dumps(commits, indent=2))
        (ws / "mr-pipelines.json").write_text(json.dumps(pipelines, indent=2))

        # Write per-file diffs + a combined diff + the changed-line index (grounding source).
        diffs_dir = ws / "diffs"
        diffs_dir.mkdir(exist_ok=True)
        file_diffs: dict[str, str] = {}
        combined: list[str] = []
        changed_paths: list[str] = []
        for d in diffs:
            path = d.get("new_path") or d.get("old_path") or "unknown"
            if mr_lib.is_generated_or_vendored(path):
                continue
            diff_text = d.get("diff", "") or ""
            file_diffs[path] = diff_text
            changed_paths.append(path)
            safe = path.replace("/", "__")
            (diffs_dir / f"{safe}.diff").write_text(diff_text)
            combined.append(f"### {path}\n```diff\n{diff_text}\n```\n")
        (ws / "full.diff").write_text("\n".join(combined))
        idx = {p: sorted(mr_lib.added_lines_from_diff(t)) for p, t in file_diffs.items()}
        (ws / "changed-index.json").write_text(json.dumps(idx, indent=2))
        (ws / "changed-files.json").write_text(json.dumps(changed_paths, indent=2))

        # Seed text for Jira/Confluence mining: title + description + commit messages.
        seed = [mr.get("title", ""), mr.get("description", "")]
        seed += [c.get("message", "") for c in commits]
        (ws / "mr-seed.txt").write_text("\n".join(seed))
        log(f"fetched MR !{ref.mr_iid}: {len(changed_paths)} reviewable file(s), "
            f"{len(commits)} commit(s)")
    return json.loads(mr_json.read_text())


def step_submission(ws: Path, mr: dict) -> None:
    notes = ws / "mr-pipelines.json"  # placeholder; discussions optional
    files = ws / "changed-files.json"
    rc = subprocess.run(
        [sys.executable, str(HERE / "submission_gate.py"),
         "--mr-json", str(ws / "mr.json"),
         "--files-json", str(files),
         "--out", str(ws)],
        capture_output=True, text=True)
    print(rc.stdout.strip())
    if rc.returncode != 0:
        log("SUBMISSION GATE: hard failure — see submission-gate.md. "
            "The review will still run, but flag this prominently.")
    else:
        log("submission gate: passed (soft flags may exist — see submission-gate.md)")


def step_clone(ref: mr_lib.MRRef, ws: Path, mr: dict, force: bool) -> Path:
    clone = ws / ref.clone_slug
    if clone.exists() and not force:
        log(f"skip — clone {clone.name} present (checkpoint)")
        return clone
    if clone.exists():
        shutil.rmtree(clone)
    token = os.environ["GITLAB_PERSONAL_ACCESS_TOKEN"]
    url = gitlab_api.build_clone_url(ref.host, ref.project_path, token)
    source = mr.get("source_branch")
    target = mr.get("target_branch")
    # Full clone (need base branch history for coverage diff); then checkout source.
    run(["git", "clone", url, str(clone)], quiet_secrets=True)
    run(["git", "fetch", "origin", source, target], cwd=clone, check=False)
    run(["git", "checkout", source], cwd=clone)
    return clone


def step_build(clone: Path, ws: Path, force: bool) -> bool:
    marker = ws / ".build-ok"
    if marker.exists() and not force:
        log("skip — build already succeeded (checkpoint)")
        return True
    install = subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=clone)
    if install.returncode != 0:
        log("pnpm install --frozen-lockfile failed; retrying without frozen lockfile")
        install = subprocess.run(["pnpm", "install"], cwd=clone)
    build = subprocess.run(["pnpm", "build"], cwd=clone)
    ok = install.returncode == 0 and build.returncode == 0
    (ws / "build-status.txt").write_text(
        f"install={install.returncode} build={build.returncode}\n")
    if ok:
        marker.write_text("ok\n")
    else:
        log("BUILD FAILED — static/coverage tool steps may be skipped; recorded in build-status.txt")
    return ok


def step_static(clone: Path, ws: Path, base: str, tools_ok: bool) -> None:
    cmd = [sys.executable, str(HERE / "review_static_gate.py"), str(clone),
           "--base", base, "--out", str(ws),
           "--changed-index", str(ws / "changed-index.json")]
    if not tools_ok:
        cmd.append("--skip-tools")
    subprocess.run(cmd, check=False)


def step_coverage(clone: Path, ws: Path, base: str, tools_ok: bool) -> None:
    if not tools_ok:
        (ws / "coverage-report.md").write_text(
            "# Coverage\n\n_Skipped — build/install failed, tests could not run locally. "
            "Fall back to CI pipeline coverage._\n")
        log("coverage: skipped (build failed)")
        return
    subprocess.run(
        [sys.executable, str(HERE / "coverage_gate.py"), str(clone),
         "--base", base, "--out", str(ws)], check=False)


def step_impact(clone: Path, ws: Path, force: bool) -> None:
    """Deterministic call-graph backtrace: touched symbols -> entry points (ts-morph).

    Independent of the target repo's build (ts-morph uses its own TS + the repo's tsconfig), so it
    runs even when `pnpm install`/build failed. Falls back to a ripgrep name-based pass if Node or
    the tracer's deps are unavailable.
    """
    out = ws / "impact-map.md"
    if done(out, force):
        return
    changed_index = ws / "changed-index.json"
    if not changed_index.exists():
        log("impact: no changed-index.json — skipping")
        return

    tracer = HERE / "node" / "impact_trace.mjs"
    used_fallback = False
    if shutil.which("node") and tracer.exists():
        rc = subprocess.run(["node", str(tracer), str(clone), str(changed_index), str(ws)])
        if rc.returncode != 0:
            log("impact: ts-morph tracer failed — using ripgrep fallback")
            used_fallback = True
    else:
        log("impact: node/ts-morph unavailable — using ripgrep fallback "
            "(run `npm install` in the package dir for the precise tracer)")
        used_fallback = True

    if used_fallback:
        subprocess.run(
            [sys.executable, str(HERE / "impact_fallback.py"),
             "--clone", str(clone), "--changed-index", str(changed_index), "--out", str(ws)],
            check=False)


JIRA_PREFIXES = "DT"   # the only Jira project these repos use


def step_context(ws: Path, force: bool) -> None:
    if done(ws / "jira-context.md", force):
        return
    subprocess.run(
        [sys.executable, str(HERE / "context_gather.py"),
         "--out", str(ws), "--seed-file", str(ws / "mr-seed.txt"),
         "--prefixes", JIRA_PREFIXES], check=False)


def step_input(ref: mr_lib.MRRef, ws: Path, mr: dict) -> None:
    """Assemble review-input.md: the grounding the LLM node reads (Step 7 input)."""
    pipelines = json.loads((ws / "mr-pipelines.json").read_text() or "[]")
    pstatus = pipelines[0].get("status") if pipelines else "none"
    changed = json.loads((ws / "changed-files.json").read_text())
    layered = "\n".join(f"| `{p}` | {mr_lib.classify_layer(p)} |" for p in changed)
    static_md = (ws / "static-findings.md").read_text() if (ws / "static-findings.md").exists() else "_none_"
    n_static = len(json.loads((ws / "static-findings.json").read_text())) if (ws / "static-findings.json").exists() else 0
    has_impact = (ws / "impact-map.md").exists()

    header = (
        "# --- REVIEW-INPUT-EXEC ---\n"
        f"schema_version: 1\n"
        f"mr_iid: {ref.mr_iid}\n"
        f"project_path: {ref.project_path}\n"
        f"project_id: {ref.project_id}\n"
        f"source_branch: {mr.get('source_branch')}\n"
        f"target_branch: {mr.get('target_branch')}\n"
        f"pipeline_status: {pstatus}\n"
        f"deterministic_findings: {n_static}\n"
        f"impact_map: {'present' if has_impact else 'absent'}\n"
        "# --- END REVIEW-INPUT-EXEC ---\n"
    )
    body = f"""{header}

# MR Review Input — {mr.get('title','')}

## How to use this file
Everything below is ALREADY ESTABLISHED by the deterministic spine. Do NOT re-derive it.
Your ONE job is the semantic review of the changed lines. Read:
- `jira-context.md` — business context, acceptance criteria, related sub-task MRs
- `full.diff` and `diffs/*.diff` — the exact changed lines (comment only within these)
- `impact-map.md` — call-graph backtrace: which entry points (routes/consumers) reach the changed
  code, and where the trace hit blind spots. Use this to ground regression + design judgment.
- `static-findings.md` — mechanical findings (linter/grep) already produced — do not repeat them
- `coverage-report.md`, `submission-gate.md`, `build-status.txt`

## Changed files (layer-classified)
| file | layer |
|---|---|
{layered}

## Deterministic static findings (already established — grounding, do NOT repeat)
{static_md}
"""
    (ws / "review-input.md").write_text(body)
    log(f"assembled review-input.md ({len(changed)} files, {n_static} static findings)")


def step_finalize(ws: Path) -> None:
    subprocess.run([sys.executable, str(HERE / "review_finalize.py"), "--ws", str(ws)], check=False)


def step_post(ws: Path, no_post: bool, dry_run: bool) -> None:
    """Deterministic posting of EVERYTHING in post-plan.json (inline + summary + coverage)."""
    plan = ws / "post-plan.json"
    if not plan.exists():
        log("post: no post-plan.json (review did not finalize) — nothing to post")
        return
    if no_post:
        log(f"--no-post: skipping. To post later, run:\n"
            f"    python3 {HERE / 'review_post.py'} --ws {ws}")
        return
    cmd = [sys.executable, str(HERE / "review_post.py"), "--ws", str(ws)]
    if dry_run:
        cmd.append("--dry-run")
    subprocess.run(cmd, check=False)


def step_cleanup(ref: mr_lib.MRRef, ws: Path, keep: bool) -> None:
    clone = ws / ref.clone_slug
    if keep:
        log(f"--keep: leaving clone at {clone}")
        return
    if clone.exists():
        shutil.rmtree(clone, ignore_errors=True)
        log(f"cleaned up clone {clone.name} (artifacts kept in {ws})")


# --------------------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------------------

# Order matters: the cheap, high-value context (Jira/Confluence/sibling MRs) is gathered EARLY —
# right after fetch — so a later hang-prone step (build/coverage/impact) can never rob the reviewer
# of business context. Everything after `context` only adds to it.
STEPS = ["fetch", "submission", "context", "clone", "build", "static", "coverage", "impact",
         "input", "review", "post", "cleanup"]


PREP_STEPS = STEPS[:STEPS.index("review")]


def _pkg_version() -> str:
    try:
        return json.loads((HERE.parent / "package.json").read_text())["version"]
    except (OSError, KeyError, ValueError):
        return "dev"


def prepare(ref: mr_lib.MRRef, args: argparse.Namespace, start: int) -> review_stages.MRWork:
    """Run the deterministic prep steps for ONE MR; returns its work record."""
    ws = WORKROOT / f"{ref.clone_slug}-{ref.mr_iid}"
    ws.mkdir(parents=True, exist_ok=True)
    log(f"MR !{ref.mr_iid} ({ref.project_path}) workspace={ws}")
    mr: dict = {}
    clone = ws / ref.clone_slug
    tools_ok = (ws / ".build-ok").exists()

    def ensure_mr() -> dict:
        nonlocal mr
        if not mr:
            mr = json.loads((ws / "mr.json").read_text())
        return mr

    for name in PREP_STEPS[start:] if start < len(PREP_STEPS) else []:
        run_record.PROGRESS["step"] = name
        if name == "fetch":
            mr = step_fetch(ref, ws, args.force)
        elif name == "submission":
            step_submission(ws, ensure_mr())
        elif name == "context":
            step_context(ws, args.force)
        elif name == "clone":
            clone = step_clone(ref, ws, ensure_mr(), args.force)
        elif name == "build":
            tools_ok = step_build(clone, ws, args.force)
        elif name == "static":
            step_static(clone, ws, ensure_mr().get("target_branch", "develop"), tools_ok)
        elif name == "coverage":
            step_coverage(clone, ws, ensure_mr().get("target_branch", "develop"), tools_ok)
        elif name == "impact":
            step_impact(clone, ws, args.force)
        elif name == "input":
            step_input(ref, ws, ensure_mr())
    return review_stages.MRWork(ref=ref, ws=ws, mr=ensure_mr())


def main() -> None:
    ap = argparse.ArgumentParser(
        prog="mr-review",
        description="Review one GitLab MR, or several related MRs (one story across services) "
                    "together: deterministic lint/type/coverage/impact gates, then a verified "
                    "find -> verify (-> gap) model review. Posts everything to each MR.",
        epilog="examples:\n"
               "  mr-review <MR_URL> --dry-run\n"
               "  mr-review <lib-MR> <svc-A-MR> <svc-B-MR> --seed \"what this story does\"\n"
               "  mr-review <MR_URL> --related <merged-MR-for-context> --depth deep\n"
               "  mr-review <MR_URL> --from review      # re-run only the model stages\n\n"
               "secrets (macOS keychain): mr-review setup [--reset]\n\n"
               "per-user defaults (like git config):\n"
               "  mr-review config set verify-model claude-opus-5.5\n"
               "  mr-review config list | get <key> | unset <key>\n"
               "  keys: find-model verify-model depth threshold parallel engine\n\n"
               "work dir: /tmp/kiro-mr-review (override with KIRO_MR_WORKROOT)",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", action="version",
                    version=f"@dfg/mr-review {os.environ.get('MR_REVIEW_VERSION') or _pkg_version()}")
    ap.add_argument("mr_urls", nargs="+", help="one or more MR URLs reviewed together as one change set")
    ap.add_argument("--seed", default="", metavar="TEXT", help="author intent: what this change set is meant to do")
    ap.add_argument("--seed-file", metavar="FILE", help="read the seed prompt from a file")
    ap.add_argument("--related", action="append", default=[], metavar="URL",
                    help="context-only MR URL (repeatable) — read by the reviewers, never commented on")
    ap.add_argument("--depth", choices=["quick", "standard", "deep"],
                    default=os.environ.get("KIRO_MR_DEPTH", "standard"),
                    help="quick=1 pass | standard=finders+verify (default) | deep=+gap sweep")
    ap.add_argument("--find-model", default=os.environ.get("KIRO_MR_FIND_MODEL", "claude-sonnet-5.5"),
                    metavar="MODEL", help="model for the finder stages (default: %(default)s)")
    ap.add_argument("--verify-model", default=os.environ.get("KIRO_MR_VERIFY_MODEL", "claude-opus-5.5"),
                    metavar="MODEL", help="model for verify + gap stages (default: %(default)s)")
    ap.add_argument("--threshold", type=int, default=int(os.environ.get("KIRO_MR_THRESHOLD", "70")),
                    help="minimum verifier confidence (0-100) to post a finding")
    ap.add_argument("--parallel", type=int, default=int(os.environ.get("KIRO_MR_PARALLEL", "3")),
                    help="max concurrent kiro-cli stage sessions")
    ap.add_argument("--engine", choices=["v2", "v3"], default=os.environ.get("KIRO_MR_ENGINE", "v2"),
                    help="kiro-cli agent engine (default: %(default)s)")
    ap.add_argument("--force", action="store_true",
                    help="redo everything: every step saves its output and a re-run of the same "
                         "MR(s) reuses it, so without --force a second run skips straight to what is "
                         "missing (fast, free). Use --force after new commits on the MR")
    ap.add_argument("--from", dest="from_step", choices=STEPS, metavar="STEP",
                    help="start at this step, reusing earlier output: " + " | ".join(STEPS))
    ap.add_argument("--no-agent", action="store_true", help="stop after the deterministic prep")
    ap.add_argument("--dry-run", action="store_true", help="review fully, show what would post, post nothing")
    ap.add_argument("--no-post", action="store_true", help="review but skip the posting step entirely")
    ap.add_argument("--keep", action="store_true", help="keep the temp clones after the run")
    args = ap.parse_args()

    rec = run_record.RunRecord(args)
    try:
        _run(args, rec)
    except BaseException as e:  # SystemExit/KeyboardInterrupt too: a failed run is still a run
        rec.fail(e)
        raise
    finally:
        rec.write(WORKROOT)


def _run(args: argparse.Namespace, rec: "run_record.RunRecord") -> None:
    run_record.PROGRESS["step"] = "parse"
    try:
        refs = [mr_lib.parse_mr_url(u.split("/diffs")[0]) for u in args.mr_urls]
        related = [u.split("/diffs")[0] for u in args.related]
    except ValueError as e:
        sys.exit(f"STOP: {e}")
    seed = Path(args.seed_file).read_text() if args.seed_file else args.seed

    start = STEPS.index(args.from_step) if args.from_step else 0
    works = [prepare(ref, args, start) for ref in refs]
    rec.works = works

    if args.no_agent:
        log("--no-agent: deterministic prep complete for "
            + ", ".join(w.key for w in works) + ". Re-run with --from review to continue.")
        return

    if start <= STEPS.index("review"):
        opts = review_stages.Options(
            depth=args.depth, engine=args.engine, find_model=args.find_model,
            verify_model=args.verify_model, threshold=args.threshold, parallel=args.parallel,
            force=args.force, seed=seed, related=related)
        run_record.PROGRESS["step"] = "review"
        cs = review_stages.review_changeset(works, WORKROOT, opts)
        rec.cs = cs
        credits = (cs / "credits.md").read_text() if (cs / "credits.md").exists() else ""
        for w in works:
            step_finalize(w.ws)
            if credits:
                with open(w.ws / "review-final.md", "a") as fh:
                    fh.write("\n\n## Credits (model stages)\n" + credits)
        if credits:
            print("\n[spine] CREDITS — " + cs.name + "\n" + credits, flush=True)

    for w in works:
        if start <= STEPS.index("post"):
            run_record.PROGRESS["step"] = "post"
            log(f"POST {w.key}")
            step_post(w.ws, args.no_post, args.dry_run)
        step_cleanup(w.ref, w.ws, args.keep)


if __name__ == "__main__":
    main()
