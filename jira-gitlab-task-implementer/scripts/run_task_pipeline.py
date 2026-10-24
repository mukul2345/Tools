#!/usr/bin/env python3
"""
run_task_pipeline.py — the deterministic spine for the Jira → GitLab task-implementer.

Sibling of the bug-fixer's run_pipeline.py, but spec/tasks-driven instead of bug-driven. A code
driver owns the sequence and calls the LLM at exactly ONE node — implement. Everything else
(config parse, Jira preflight, clone, task selection, branch prep, coverage + compliance re-checks)
is deterministic and runs here at 0 credits.

    preflight → gather → clone → references → select → branch → implement(LLM) → coverage → compliance → report
    └──────────────────────── hard gates + context, 0 credits ────────────────┘   Opus    └── re-verify ──┘

`gather` (Jira + Confluence history) and `references` (keyword-grounded read-only context) enrich
the implement node without spending tokens; both are best-effort (a failure is a warning, not a
STOP — the spec is the source of truth). The preflight/clone/select/branch checks are HARD GATES:
if the repo is unreachable, the source branch is missing, the spec/tasks.md is absent, the Jira
subtask doesn't resolve, or the selected task ids are invalid, the run STOPs before a token is
spent. Steps checkpoint to files, so a re-run resumes at the first missing output; --force redoes
everything and --from <step> resumes at a named step.

    ./run_task_pipeline.py --config run.yml [--jira DT-1] [--branch NAME] [--model opus]
                           [--force] [--from STEP] [--headless]

Secrets are read from the environment (the launcher exports them from the keychain):
    GITLAB_PERSONAL_ACCESS_TOKEN   (clone + the agent's push)
    ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN / JIRA_BASE_URL   (Jira preflight)
    KIRO_API_KEY   (optional; when set with --headless the agent runs non-interactively)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import jira_client
import task_pipeline_lib as lib

HERE = Path(__file__).resolve().parent
WORK_ROOT = Path(os.environ.get("KIRO_TASK_WORKROOT", "/tmp/kiro-task"))
AGENT_NAME = os.environ.get("KIRO_TASK_AGENT", "task-implementer")
# Invoke child scripts with the SAME interpreter running the spine, so they share its environment
# (e.g. a venv that has PyYAML). Falls back to "python3" if sys.executable is somehow empty.
PY = sys.executable or "python3"


# --------------------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------------------

def log(msg: str) -> None:
    print(f"[spine] {msg}", flush=True)


def stop(msg: str) -> "None":
    """Emit a clear STOP and exit non-zero (a halted run with a reason is a success, not a crash)."""
    print(f"\n[spine] STOP — {msg}", file=sys.stderr, flush=True)
    sys.exit(3)


def run(cmd: list[str], cwd: Optional[Path] = None, redact: Optional[list[str]] = None,
        check: bool = True) -> subprocess.CompletedProcess:
    """Run a command, streaming output. `redact` values are masked in the echoed command line."""
    shown = " ".join(cmd)
    for secret in (redact or []):
        if secret:
            shown = shown.replace(secret, "***")
    log("$ " + shown)
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=check)


def run_capture(cmd: list[str], cwd: Optional[Path] = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True)


def done(path: Path, force: bool) -> bool:
    if path.exists() and not force:
        log(f"skip — {path.name} already present (checkpoint)")
        return True
    return False


def _dir_size_mb(path: Path) -> int:
    """Approximate directory size in MB (best-effort; for a helpful cleanup hint)."""
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for f in files:
                try:
                    total += (Path(root) / f).stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total // (1024 * 1024)


# --------------------------------------------------------------------------------------
# Repo URL + git helpers (shared normalizers live in task_pipeline_lib)
# --------------------------------------------------------------------------------------

def token_clone_url(url: str, token: str) -> str:
    """lib.token_clone_url, converting a parse error into a clean spine STOP."""
    try:
        return lib.token_clone_url(url, token)
    except ValueError as e:
        stop(str(e))
        raise AssertionError  # unreachable


def branch_exists(clone_dir: Path, branch: str) -> bool:
    r = run_capture(["git", "rev-parse", "--verify", "--quiet", f"origin/{branch}"], cwd=clone_dir)
    return r.returncode == 0


def read_file_from_ref(clone_dir: Path, ref: str, rel_path: str) -> Optional[str]:
    """`git show <ref>:<path>` — read a file from a branch without checking it out."""
    r = run_capture(["git", "show", f"{ref}:{rel_path}"], cwd=clone_dir)
    return r.stdout if r.returncode == 0 else None


# --------------------------------------------------------------------------------------
# Run context (assembled by preflight, consumed by every later step)
# --------------------------------------------------------------------------------------

@dataclass
class RunContext:
    cfg: lib.RunConfig
    issue: jira_client.JiraIssue
    work_branch: str
    target_branch: str
    model_id: str
    repo_name: str
    workspace: Path
    clone_dir: Path
    spec_ref: str                 # branch the spec/tasks.md is read from (repo mode)
    tasks_md_repo_rel: str        # repo-relative path to tasks.md (repo mode)
    tasks_md_local: Optional[str] = None  # absolute path (local mode)
    selection: Optional[lib.TaskSelectionResult] = None


# --------------------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------------------

def step_preflight(config_path: str, overrides: dict, fresh: bool = False) -> RunContext:
    """Deterministic hard gates: parse config, verify secrets, resolve the Jira subtask + model,
    and derive the work branch. No LLM, minimal network (one Jira GET). Always runs."""
    log("PREFLIGHT — config + secrets + Jira subtask (hard gates, 0 credits)")

    try:
        cfg = lib.load_run_config(config_path, overrides)
    except lib.ConfigError as e:
        stop(f"invalid run config: {e}")

    token = os.environ.get("GITLAB_PERSONAL_ACCESS_TOKEN", "").strip()
    if not token:
        stop("GITLAB_PERSONAL_ACCESS_TOKEN is not set (needed to clone + push). "
             "Export it from the keychain via the launcher.")

    try:
        issue = jira_client.get_issue(cfg.jira_id)
    except jira_client.JiraError as e:
        stop(f"Jira preflight failed for {cfg.jira_id}: {e}")

    log(f"Jira {issue.key}: '{issue.summary}' [{issue.issue_type} / {issue.status}]"
        + (f" parent={issue.parent_key}" if issue.parent_key else ""))

    model_id = cfg.resolved_model()
    work_branch = (lib.derive_branch_name(cfg.jira_id, issue.summary)
                   if cfg.branch_name.lower() == "auto" else cfg.branch_name)
    target_branch = cfg.effective_target_branch()
    repo_name = lib.repo_name_from_url(cfg.repo_url)

    workspace = WORK_ROOT / cfg.jira_id / lib.slugify_branch(work_branch)
    if fresh and workspace.exists():
        log(f"--fresh: removing existing workspace {workspace} (starting clean, not resuming)")
        shutil.rmtree(workspace, ignore_errors=True)
    workspace.mkdir(parents=True, exist_ok=True)
    clone_dir = workspace / repo_name

    spec_ref = (cfg.spec.branch or cfg.source_branch) if cfg.spec.location == "repo" else ""
    tasks_md_repo_rel = f"{cfg.spec.path.rstrip('/')}/tasks.md" if cfg.spec.location == "repo" else ""
    tasks_md_local = (str(Path(cfg.spec.path).expanduser() / "tasks.md")
                      if cfg.spec.location == "local" else None)

    ctx = RunContext(
        cfg=cfg, issue=issue, work_branch=work_branch, target_branch=target_branch,
        model_id=model_id, repo_name=repo_name, workspace=workspace, clone_dir=clone_dir,
        spec_ref=spec_ref, tasks_md_repo_rel=tasks_md_repo_rel, tasks_md_local=tasks_md_local,
    )

    (workspace / "preflight.json").write_text(json.dumps({
        "jira": issue.as_dict(),
        "repo_url": cfg.repo_url, "repo_name": repo_name,
        "source_branch": cfg.source_branch, "work_branch": work_branch,
        "target_branch": target_branch, "model": model_id,
        "spec": {"location": cfg.spec.location, "path": cfg.spec.path, "ref": spec_ref},
        "flags": {"unit_tests": cfg.unit_tests, "create_mr": cfg.create_mr,
                  "testing_artifacts": cfg.testing_artifacts},
    }, indent=2))
    log(f"workspace={workspace}  work_branch={work_branch}  model={model_id}")
    return ctx


def step_gather(ctx: RunContext, force: bool) -> None:
    """Deterministic Jira + Confluence history gather (best-effort — a failure is a warning).

    Walks the linked-issue graph (parent/child/sibling/linked + mentioned keys), pulls comments,
    and fetches linked Confluence page content into ticket-history.md/.json for the agent to read.
    """
    if not ctx.cfg.jira.enabled:
        log("gather — SKIPPED (jira.gather: false).")
        return
    out = ctx.workspace / "ticket-history.md"
    if done(out, force):
        return
    j = ctx.cfg.jira
    log("gather — Jira + Confluence history (deterministic, 0 credits)")
    cmd = [PY, str(HERE / "jira_gather.py"), ctx.issue.key,
           "--out", str(ctx.workspace),
           "--max-depth", str(j.max_depth), "--max-tickets", str(j.max_tickets),
           "--max-confluence", str(j.max_confluence)]
    if j.project_prefixes:
        cmd += ["--project-prefixes", ",".join(j.project_prefixes)]
    if not j.confluence:
        cmd += ["--no-confluence"]
    r = run(cmd, check=False)
    if r.returncode != 0:
        log("WARNING: Jira gather failed — continuing without ticket history (the spec is the "
            "source of truth). See output above.")


def step_references(ctx: RunContext, force: bool) -> None:
    """Distill read-only reference context (best-effort — a failure is a warning)."""
    if ctx.cfg.references.empty:
        log("references — none configured; skipping.")
        return
    out = ctx.workspace / "references" / "reference-context.md"
    if done(out, force):
        return
    log("references — cloning + distilling grounding context (deterministic, 0 credits)")
    spec = {
        "keywords": ctx.cfg.references.keywords,
        "repos": [{"url": r.url, "branch": r.branch, "paths": r.paths, "keywords": r.keywords}
                  for r in ctx.cfg.references.repos],
        "local": [{"path": l.path, "paths": l.paths, "keywords": l.keywords}
                  for l in ctx.cfg.references.local],
    }
    spec_path = ctx.workspace / "references-spec.json"
    spec_path.write_text(json.dumps(spec, indent=2))
    r = run([PY, str(HERE / "reference_gather.py"),
             "--spec", str(spec_path), "--out", str(ctx.workspace / "references")], check=False)
    if r.returncode != 0:
        log("WARNING: reference gather failed — continuing without reference context. "
            "See output above.")


def step_clone(ctx: RunContext, force: bool) -> None:
    """Clone the repo (token URL so push works later) + verify the source/spec branches exist."""
    marker = ctx.workspace / "clone.ok"
    token = os.environ["GITLAB_PERSONAL_ACCESS_TOKEN"]

    if not done(marker, force):
        if ctx.clone_dir.exists():
            run(["rm", "-rf", str(ctx.clone_dir)])
        curl = token_clone_url(ctx.cfg.repo_url, token)
        run(["git", "clone", curl, str(ctx.clone_dir)], redact=[token])
        marker.write_text("ok\n")
    else:
        # Even on checkpoint, make sure remote refs are current for branch verification.
        run(["git", "fetch", "--prune", "origin"], cwd=ctx.clone_dir, check=False)

    if not branch_exists(ctx.clone_dir, ctx.cfg.source_branch):
        stop(f"source_branch '{ctx.cfg.source_branch}' not found on origin. "
             f"Fix source_branch in the config.")

    if ctx.cfg.spec.location == "repo":
        if not branch_exists(ctx.clone_dir, ctx.spec_ref):
            stop(f"spec branch '{ctx.spec_ref}' not found on origin. "
                 f"Set spec.branch (or fix source_branch).")
        tasks_text = read_file_from_ref(ctx.clone_dir, f"origin/{ctx.spec_ref}",
                                        ctx.tasks_md_repo_rel)
        if tasks_text is None:
            stop(f"tasks.md not found at '{ctx.tasks_md_repo_rel}' on branch "
                 f"'{ctx.spec_ref}'. Check spec.path.")
        (ctx.workspace / "tasks.md").write_text(tasks_text)
    else:  # local
        local = Path(ctx.tasks_md_local or "")
        if not local.exists():
            stop(f"local tasks.md not found at '{local}'. Check spec.path / spec.location.")
        (ctx.workspace / "tasks.md").write_text(local.read_text())

    log(f"clone ready at {ctx.clone_dir}; tasks.md staged for selection.")


def step_select(ctx: RunContext, force: bool) -> None:
    """Parse tasks.md + resolve the task selection deterministically. Hard gate on bad ids/empty."""
    out = ctx.workspace / "selected-tasks.json"
    tasks_md = ctx.workspace / "tasks.md"
    if not tasks_md.exists():
        stop("tasks.md was not staged — the clone step must run first.")

    tasks = lib.parse_tasks(tasks_md.read_text())
    if not tasks:
        stop(f"no parseable task checkboxes in {ctx.tasks_md_repo_rel or ctx.tasks_md_local}. "
             f"Expected lines like `- [ ] 15.4 Title`.")

    result = lib.select_tasks(tasks, ctx.cfg.tasks)
    if result.errors:
        stop("task selection failed:\n  - " + "\n  - ".join(result.errors))
    if not result.selected:
        stop(f"selection '{result.mode}' matched no runnable tasks "
             f"(done skipped: {result.skipped_done}; optional skipped: {result.skipped_optional}). "
             f"Nothing to implement.")

    ctx.selection = result
    payload = {
        "mode": result.mode,
        "include_optional": ctx.cfg.tasks.include_optional,
        "selected": [t.as_dict() for t in result.selected],
        "skipped_done": result.skipped_done,
        "skipped_optional": result.skipped_optional,
        # annotate likely test-only tasks (agent decides skips when unit_tests: false)
        "test_only_hints": [t.id for t in result.selected if lib.looks_like_test_task(t)],
    }
    out.write_text(json.dumps(payload, indent=2))
    ids = [t.id for t in result.selected]
    log(f"selection[{result.mode}] → {ids}")
    if result.skipped_done:
        log(f"  (skipped completed: {result.skipped_done})")
    if result.skipped_optional:
        log(f"  (skipped optional: {result.skipped_optional})")


def step_branch(ctx: RunContext, force: bool) -> None:
    """Check out source_branch and create/checkout the work branch in the clone."""
    marker = ctx.workspace / "branch.ok"
    # Always ensure we are on the work branch (cheap + idempotent), even on checkpoint resume.
    run(["git", "checkout", ctx.cfg.source_branch], cwd=ctx.clone_dir)
    exists = run_capture(["git", "rev-parse", "--verify", "--quiet", ctx.work_branch],
                         cwd=ctx.clone_dir).returncode == 0
    if exists:
        run(["git", "checkout", ctx.work_branch], cwd=ctx.clone_dir)
    else:
        run(["git", "checkout", "-b", ctx.work_branch], cwd=ctx.clone_dir)
    marker.write_text(ctx.work_branch + "\n")
    log(f"on branch {ctx.work_branch} (forked from {ctx.cfg.source_branch})")


def _context_paths(ctx: RunContext) -> dict:
    """Paths to the deterministic context the agent should consult (read-only). None if absent."""
    th_md = ctx.workspace / "ticket-history.md"
    th_json = ctx.workspace / "ticket-history.json"
    ref_md = ctx.workspace / "references" / "reference-context.md"
    refs_dir = ctx.workspace / "references"
    confluence_count = 0
    if th_json.exists():
        try:
            confluence_count = len(json.loads(th_json.read_text()).get("confluence", []))
        except (ValueError, OSError):
            pass
    return {
        "ticket_history_md": str(th_md) if th_md.exists() else None,
        "ticket_history_json": str(th_json) if th_json.exists() else None,
        "reference_context_md": str(ref_md) if ref_md.exists() else None,
        "references_dir": str(refs_dir) if refs_dir.exists() else None,
        "confluence_count": confluence_count,
    }


def _write_task_brief(ctx: RunContext) -> Path:
    """The single JSON contract the implement node reads — all resolved params + paths."""
    assert ctx.selection is not None
    brief = {
        "jira_id": ctx.issue.key,
        "jira_summary": ctx.issue.summary,
        "repo": {"url": ctx.cfg.repo_url, "name": ctx.repo_name, "clone_dir": str(ctx.clone_dir)},
        "context": _context_paths(ctx),
        "branches": {"source": ctx.cfg.source_branch, "work": ctx.work_branch,
                     "target": ctx.target_branch},
        "spec": {
            "location": ctx.cfg.spec.location,
            "path": ctx.cfg.spec.path,
            "ref": ctx.spec_ref,
            "tasks_md": (str(ctx.clone_dir / ctx.tasks_md_repo_rel)
                         if ctx.cfg.spec.location == "repo" else ctx.tasks_md_local),
            "tasks_md_repo_rel": ctx.tasks_md_repo_rel,
        },
        "tasks": json.loads((ctx.workspace / "selected-tasks.json").read_text()),
        "flags": {"unit_tests": ctx.cfg.unit_tests, "create_mr": ctx.cfg.create_mr,
                  "testing_artifacts": ctx.cfg.testing_artifacts},
        "model": ctx.model_id,
        "reviewers": ctx.cfg.reviewers,
        "test_command": ctx.cfg.test_command,
        "gate_scripts": {
            "coverage": str(HERE / "coverage_gate.py"),
            "compliance": str(HERE / "compliance_gate.py"),
            "artifacts": str(HERE / "build_verification_artifacts.py"),
        },
        "outputs": {"implementation_md": str(ctx.workspace / "implementation.md")},
    }
    p = ctx.workspace / "task-brief.json"
    p.write_text(json.dumps(brief, indent=2))
    return p


def step_implement(ctx: RunContext, headless: bool, force: bool) -> None:
    """THE ONE LLM NODE (Opus). Implements the selected tasks, runs the gate scripts, commits per
    task (updating tasks.md), pushes, opens the MR (if create_mr), comments on Jira, and writes
    implementation.md."""
    out = ctx.workspace / "implementation.md"
    if done(out, force):
        return
    brief = _write_task_brief(ctx)
    log(f"LLM NODE — implement ({ctx.model_id}). brief={brief}")

    prompt = (
        f"Read your task brief at {brief} and the selected tasks at "
        f"{ctx.workspace / 'selected-tasks.json'}. The repo is already cloned at "
        f"{ctx.clone_dir} on branch {ctx.work_branch} (forked from {ctx.cfg.source_branch}). "
        f"First consult the read-only context in the brief's `context` (Jira + Confluence history "
        f"and the reference-context digest, if present) to ground your work. "
        f"Follow your run loop exactly: implement ONLY the selected tasks in order, enforce the "
        f"coding + unit-test guidelines, run the coverage + compliance gate scripts as hard gates "
        f"before pushing, update + commit tasks.md per completed task, then "
        f"{'push and open an MR' if ctx.cfg.create_mr else 'push the branch only (no MR)'}, "
        f"comment on Jira {ctx.issue.key}, and write {out} with the IMPL-EXEC block on every exit."
    )

    cmd = ["kiro-cli", "chat", "--agent", AGENT_NAME, "--model", ctx.model_id]
    if headless:
        cmd += ["--no-interactive", "--trust-tools=read,write,shell", "--require-mcp-startup"]
    cmd += [prompt]
    run(cmd, cwd=ctx.workspace)


def step_coverage(ctx: RunContext) -> None:
    """Independent scripted coverage re-check (skipped when unit_tests: false)."""
    if not ctx.cfg.unit_tests:
        log("coverage gate — SKIPPED (unit_tests: false).")
        return
    impl = lib.read_impl_status(ctx.workspace / "implementation.md")
    if impl.get("status") != "implemented":
        log(f"coverage gate — skipped (implement status={impl.get('status')}, "
            f"stop_reason={impl.get('stop_reason')}).")
        return
    cmd = [PY, str(HERE / "coverage_gate.py"), str(ctx.clone_dir),
           "--base", ctx.cfg.source_branch]
    if ctx.cfg.test_command:
        cmd += ["--test-cmd", ctx.cfg.test_command]
    r = run(cmd, check=False)
    if r.returncode != 0:
        stop("coverage gate failed on re-check (see output above). The branch is pushed; a human "
             "must review before merge.")


def step_compliance(ctx: RunContext) -> None:
    """Independent scripted compliance re-check (defense in depth)."""
    impl = lib.read_impl_status(ctx.workspace / "implementation.md")
    if impl.get("status") != "implemented":
        log(f"compliance gate — skipped (implement status={impl.get('status')}).")
        return
    r = run([PY, str(HERE / "compliance_gate.py"), str(ctx.clone_dir),
             "--base", ctx.cfg.source_branch], check=False)
    if r.returncode != 0:
        stop("compliance gate failed on re-check (see output above). The branch is pushed; a human "
             "must review before merge.")


def step_report(ctx: RunContext) -> None:
    impl = lib.read_impl_status(ctx.workspace / "implementation.md")
    log(f"DONE {ctx.issue.key} [{ctx.selection.mode if ctx.selection else '?'}]  "
        f"status={impl.get('status')}  branch={ctx.work_branch}")
    ctxp = _context_paths(ctx)
    log(f"artifacts: {ctx.workspace} (preflight.json, ticket-history.md/.json, "
        f"references/, selected-tasks.json, task-brief.json, implementation.md); "
        f"clone kept at {ctx.clone_dir}")
    if ctxp["ticket_history_md"]:
        log(f"  context: Jira history ({ctxp['confluence_count']} Confluence page(s))"
            + (" + reference-context.md" if ctxp["reference_context_md"] else ""))
    log("push/MR/Jira-comment were performed by the implement node (it holds the GitLab + Jira MCP).")
    if impl.get("status") != "implemented":
        # No implementation.md (interrupted / crashed) or an explicit stop: the workspace is kept
        # so you can resume or inspect. Tell the user how to start clean instead.
        log(f"NOTE: implement status={impl.get('status')} — the run did not complete. The "
            f"~{_dir_size_mb(ctx.workspace)}MB workspace is kept. Re-run WITHOUT --fresh to resume, "
            f"or WITH --fresh (or `rm -rf {ctx.workspace}`) to start clean.")


# --------------------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------------------

STEPS = ["preflight", "gather", "references", "clone", "select", "branch", "implement",
         "coverage", "compliance", "report"]


def main() -> None:
    ap = argparse.ArgumentParser(description="Deterministic spine for the Jira→GitLab task-implementer.")
    ap.add_argument("--config", required=True, help="path to the per-run YAML config")
    ap.add_argument("--jira", help="override jira_id from the config")
    ap.add_argument("--branch", help="override branch_name from the config")
    ap.add_argument("--model", help="override model from the config (opus|sonnet|... or exact id)")
    ap.add_argument("--force", action="store_true", help="ignore checkpoints; redo every step")
    ap.add_argument("--from", dest="from_step", choices=STEPS, help="resume from this step")
    ap.add_argument("--headless", action="store_true", help="run the agent non-interactively")
    ap.add_argument("--fresh", action="store_true",
                    help="wipe this run's workspace before starting (start clean, not resume)")
    ap.add_argument("--cleanup", action="store_true",
                    help="remove the workspace after a successful (status: implemented) run")
    args = ap.parse_args()

    overrides = {"jira_id": args.jira, "branch_name": args.branch, "model": args.model}
    ctx = step_preflight(args.config, overrides, fresh=args.fresh)   # always runs (establishes context)

    start = STEPS.index(args.from_step) if args.from_step else 0
    force = args.force

    for name in STEPS[start:]:
        if name == "preflight":
            continue  # already done above
        elif name == "gather":
            step_gather(ctx, force)
        elif name == "references":
            step_references(ctx, force)
        elif name == "clone":
            step_clone(ctx, force)
        elif name == "select":
            step_select(ctx, force)
        elif name == "branch":
            step_branch(ctx, force)
        elif name == "implement":
            if ctx.selection is None:      # resuming mid-pipeline (e.g. --from implement)
                step_select(ctx, force=False)
            step_implement(ctx, args.headless, force)
        elif name == "coverage":
            step_coverage(ctx)
        elif name == "compliance":
            step_compliance(ctx)
        elif name == "report":
            step_report(ctx)

    # Opt-in post-run cleanup: only wipe on a genuinely completed run (never on a STOP, which
    # exits earlier and keeps the workspace for inspection).
    if args.cleanup:
        impl = lib.read_impl_status(ctx.workspace / "implementation.md")
        if impl.get("status") == "implemented":
            log(f"--cleanup: removing workspace {ctx.workspace} (run completed).")
            shutil.rmtree(ctx.workspace, ignore_errors=True)
        else:
            log(f"--cleanup: keeping workspace (status={impl.get('status')}, not 'implemented').")


if __name__ == "__main__":
    main()
