#!/usr/bin/env python3
"""
review_stages.py — the LLM half of the spine, run over a CHANGE SET of one or more MRs.

The deterministic prep (fetch .. input) has already run per MR. This module drives the model
stages headlessly (`kiro-cli chat --no-interactive`), each in a fresh session so no stage inherits
another's reasoning, and turns their markdown into per-MR `review.md` files that the existing
deterministic `review_finalize.py` consumes unchanged.

    FIND    2-3 narrow finders in parallel (recall)      logic | tests | integration (multi-MR)
    MERGE   ground every finding in its MR's diff, dedupe, number them          (code, 0 credits)
    VERIFY  one fresh-context pass on a stronger model: confirm/reject + 0-100   (precision)
    GAP     deep only: "what did the finders miss?" -> its findings are verified too
    APPLY   keep CONFIRMED with confidence >= threshold; write per-MR review.md + the rejected
            list (verifier-dropped.json) for audit                                (code)

depth: quick = one combined finder, no verify | standard = finders + verify | deep = + gap.

Every stage checkpoints its output file; a re-run (`--from review`) resumes at the first missing
one. A stage that produces no output fails the run loudly instead of posting unverified noise.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import gitlab_api
import mr_lib
from review_finalize import parse_pipe_table

ASSETS = Path(__file__).resolve().parent.parent   # repo root (or the deployed work dir)
AGENT_NAME = "mr-review-spine"                     # workspace-local; never collides with ~/.kiro
STAGE_TIMEOUT = int(os.environ.get("KIRO_MR_STAGE_TIMEOUT", "1800"))
DIMENSIONS = {"business_logic", "regression", "test_coverage", "code_quality", "performance"}


def log(msg: str) -> None:
    print(f"[review] {msg}", flush=True)


@dataclass
class MRWork:
    ref: mr_lib.MRRef
    ws: Path
    mr: dict

    @property
    def key(self) -> str:
        return f"{self.ref.clone_slug}!{self.ref.mr_iid}"


@dataclass
class Options:
    depth: str = "standard"                  # quick | standard | deep
    engine: str = "v2"                       # v2 | v3
    find_model: str = "claude-sonnet-5.5"
    verify_model: str = "claude-opus-5.5"
    threshold: int = 70
    parallel: int = 3
    force: bool = False
    seed: str = ""
    related: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------------------
# Change-set workspace
# --------------------------------------------------------------------------------------

def changeset_dir(workroot: Path, works: list[MRWork]) -> Path:
    keys = ",".join(sorted(w.key for w in works))
    return workroot / f"cs-{hashlib.sha1(keys.encode()).hexdigest()[:8]}"


def _write_globs(cs: Path) -> list[str]:
    """Write-allowlist globs for a change-set dir, covering the macOS /tmp -> /private/tmp
    symlink so kiro-cli matches whichever form it resolves the path to."""
    real = str(cs.resolve())
    globs = [f"{real}/**"]
    # /private/tmp/x resolves back to /tmp/x on macOS; also allow the /private twin explicitly.
    if real.startswith("/private/"):
        globs.append(f"{real[len('/private'):]}/**")
    elif real.startswith("/tmp/") or real.startswith("/var/"):
        globs.append(f"/private{real}/**")
    return globs


def materialise_agent(cs: Path) -> None:
    """Copy the agent profile + its prompt + steering into <cs>/.kiro/agents/.

    A workspace-local profile keeps the run self-contained: no dependency on what is (or is not)
    installed in ~/.kiro/agents, and always in sync with these scripts. URIs in the profile are
    relative (V3 rejects absolute file:// prompt URIs)."""
    dst = cs / ".kiro" / "agents"
    (dst / "steering").mkdir(parents=True, exist_ok=True)
    profile = json.loads((ASSETS / "agents" / "mr-reviewer.json").read_text())
    profile["name"] = AGENT_NAME
    # The static profile allowlists only the default workroot. Under a custom KIRO_MR_WORKROOT
    # the stage output file falls outside it, and the write silently needs interactive approval
    # (which a --no-interactive session cannot give), so the stage finishes with no output file.
    # Derive the write allowlist from the real change-set dir so every workroot writes headlessly.
    allowed = _write_globs(cs)
    profile.setdefault("toolsSettings", {}).setdefault("write", {})["allowedPaths"] = allowed
    for rule in profile.get("permissions", {}).get("rules", []):
        if rule.get("capability") == "fs_write":
            rule["match"] = allowed
    (dst / f"{AGENT_NAME}.json").write_text(json.dumps(profile, indent=2))
    shutil.copy(ASSETS / "agents" / "mr-reviewer-prompt.md", dst / "mr-reviewer-prompt.md")
    for md in (ASSETS / "steering").glob("*.md"):
        shutil.copy(md, dst / "steering" / md.name)


def fetch_related(cs: Path, urls: list[str]) -> list[tuple[str, str, Path]]:
    """Fetch context-only MRs (title, description, diff) into <cs>/related/. Never reviewed."""
    out: list[tuple[str, str, Path]] = []
    rel_dir = cs / "related"
    rel_dir.mkdir(exist_ok=True)
    for url in urls:
        ref = mr_lib.parse_mr_url(url)
        key = f"{ref.clone_slug}!{ref.mr_iid}"
        path = rel_dir / f"{key.replace('!', '-')}.md"
        if not path.exists():
            client = gitlab_api.GitLabClient.from_env(ref.host, ref.project_id)
            mr = client.get_merge_request(ref.mr_iid)
            parts = [f"# {key} — {mr.get('title', '')}", f"URL: {url}",
                     f"Branches: {mr.get('source_branch')} -> {mr.get('target_branch')}", "",
                     "## Description", (mr.get("description") or "_none_")[:4000], "", "## Diff"]
            for d in client.list_changed_files(ref.mr_iid):
                p = d.get("new_path") or d.get("old_path") or "unknown"
                if not mr_lib.is_generated_or_vendored(p):
                    parts.append(f"### {p}\n```diff\n{d.get('diff', '')}\n```")
            path.write_text("\n".join(parts))
            log(f"related context fetched: {key}")
        out.append((key, url, path))
    return out


def write_changeset_md(cs: Path, works: list[MRWork], seed: str,
                       related: list[tuple[str, str, Path]]) -> None:
    lines = ["# Change set", ""]
    if seed.strip():
        lines += ["## Author intent (seed prompt) — what these changes are meant to do",
                  "Treat this as the author's stated goal: check the code actually achieves it.", "",
                  seed.strip(), ""]
    lines += ["## MRs under review — comment ONLY on these, ONLY on their changed lines", ""]
    for w in works:
        clone = w.ws / w.ref.clone_slug
        desc = (w.mr.get("description") or "").strip()[:1500] or "_none_"
        lines += [f"### {w.key} — {w.mr.get('title', '')}",
                  f"- url: {w.ref.url}",
                  f"- branches: {w.mr.get('source_branch')} -> {w.mr.get('target_branch')}",
                  f"- workspace: {w.ws}",
                  f"- diff: {w.ws}/full.diff (per file: {w.ws}/diffs/)",
                  f"- source checkout: {clone}" + ("" if clone.exists() else " (ABSENT — use the diff)"),
                  f"- grounding: review-input.md, jira-context.md, impact-map.md, "
                  f"static-findings.md, coverage-report.md (all in the workspace)",
                  "- description:", "", desc, ""]
    if related:
        lines += ["## Related MRs — CONTEXT ONLY, never comment on these", ""]
        lines += [f"- {k}: {u} — {p}" for k, u, p in related]
        lines += [""]
    (cs / "changeset.md").write_text("\n".join(lines))


# --------------------------------------------------------------------------------------
# Headless kiro-cli
# --------------------------------------------------------------------------------------

# V3 auto-approves only exact tool IDs headlessly; V2 honours the profile's allowedTools.
V3_TRUST = "read_file,grep_search,fs_write"


def kiro_cmd(opts: Options, model: str, run_file: Path) -> list[str]:
    # stream-json = JSON Lines events; their meteringUsage entries are how credits are counted
    cmd = ["kiro-cli", "chat", f"--{opts.engine}", "--no-interactive", "--output-format",
           "stream-json", "--agent", AGENT_NAME, "--model", model]
    if opts.engine == "v3":
        cmd.append(f"--trust-tools={V3_TRUST}")
    cmd.append(f"Read {run_file} and follow it exactly. Write only the output file it names.")
    return cmd


def stage_usage(log_path: Path) -> dict:
    """Sum the credits a stage used from its stream-json log (`meteringUsage` per turn)."""
    credits, ms, turns = 0.0, 0, 0
    if log_path.exists():
        for line in log_path.read_text(errors="replace").splitlines():
            if '"meteringUsage"' not in line:
                continue
            try:
                data = json.loads(line).get("data", {})
            except ValueError:
                continue
            for u in data.get("meteringUsage") or []:
                if u.get("unit") == "credit":
                    credits += float(u.get("value") or 0)
            ms += int(data.get("turnDurationMs") or 0)
            turns += 1
    return {"credits": round(credits, 3), "seconds": round(ms / 1000), "turns": turns}


def record_usage(cs: Path, name: str, model: str, reused: bool) -> None:
    path = cs / "credits.json"
    book = json.loads(path.read_text()) if path.exists() else {}
    if reused and name in book:
        book[name]["reused"] = True
    else:
        book[name] = {"model": model, "reused": reused, **stage_usage(cs / "logs" / f"{name}.log")}
    path.write_text(json.dumps(book, indent=2))


def usage_report(cs: Path, n_mrs: int) -> str:
    """Per-stage credits table + total for this change set."""
    path = cs / "credits.json"
    book = json.loads(path.read_text()) if path.exists() else {}
    rows = ["| stage | model | credits | time | note |", "|---|---|---|---|---|"]
    spent = 0.0
    for name, u in book.items():
        note = "reused (0 this run)" if u.get("reused") else ""
        if not u.get("reused"):
            spent += u["credits"]
        rows.append(f"| {name} | {u['model']} | {u['credits']:.2f} | {u['seconds']}s | {note} |")
    total = sum(u["credits"] for u in book.values())
    rows.append(f"| **total** | | **{total:.2f}** | | spent this run: {spent:.2f} |")
    if n_mrs > 1:
        rows.append(f"\n_One change set of {n_mrs} MRs reviewed together — stages are shared, so "
                    f"per MR ≈ {total / n_mrs:.2f} credits on average._")
    rows.append("\n_Model stages only; the deterministic steps (fetch, lint, coverage, impact, "
                "posting) cost 0 credits._")
    return "\n".join(rows)


def run_stages(cs: Path, opts: Options, stages: list[tuple[str, str, str, Path]]) -> None:
    """Run (name, model, instruction, out_path) stages, up to opts.parallel at a time.

    Each stage is a fresh kiro-cli session with cwd=<cs> (so the workspace-local agent loads).
    A stage whose output already exists is skipped unless --force."""
    import time
    (cs / "run").mkdir(exist_ok=True)
    (cs / "logs").mkdir(exist_ok=True)
    pending = []
    for st in stages:
        if st[3].exists() and not opts.force:
            log(f"skip {st[0]} — {st[3].name} present (checkpoint)")
            record_usage(cs, st[0], st[1], reused=True)
        else:
            pending.append(st)
    running: list[tuple[str, Path, subprocess.Popen, object, float]] = []
    models = {st[0]: st[1] for st in stages}

    def reap() -> None:
        for item in list(running):
            name, out, proc, fh, t0 = item
            if proc.poll() is None and time.time() - t0 > STAGE_TIMEOUT:
                proc.kill()
                proc.wait()
                log(f"{name}: TIMEOUT after {STAGE_TIMEOUT}s")
            if proc.poll() is None:
                continue
            fh.close()
            running.remove(item)
            ok = out.exists() and out.stat().st_size > 0
            record_usage(cs, name, models[name], reused=False)
            used = json.loads((cs / "credits.json").read_text())[name]
            log(f"{name}: exit={proc.returncode} output={'ok' if ok else 'MISSING'} "
                f"credits={used['credits']:.2f} time={used['seconds']}s")

    for name, model, instruction, out in pending:
        while len(running) >= max(1, opts.parallel):
            time.sleep(5)
            reap()
        if out.exists():
            out.unlink()
        run_file = cs / "run" / f"{name}.md"
        run_file.write_text(instruction)
        fh = open(cs / "logs" / f"{name}.log", "w")
        log(f"{name}: kiro-cli {opts.engine} model={model}")
        proc = subprocess.Popen(kiro_cmd(opts, model, run_file), cwd=cs,
                                stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        running.append((name, out, proc, fh, time.time()))
    while running:
        time.sleep(5)
        reap()

    missing = [n for n, _m, _i, o in stages if not o.exists() or o.stat().st_size == 0]
    if missing:
        raise SystemExit(f"STOP: review stage(s) produced no output: {', '.join(missing)}. "
                         f"See {cs}/logs/. Re-run with --from review to resume.")


# --------------------------------------------------------------------------------------
# Instructions
# --------------------------------------------------------------------------------------

def _prompt(name: str) -> str:
    return (ASSETS / "prompts" / f"{name}.md").read_text()


def stage_header(cs: Path, stage: str, out: Path) -> str:
    return (f"# Stage: {stage}\n\n"
            f"You are ONE stage of a headless MR-review pipeline. No human is present: never ask "
            f"questions, decide and proceed. Start by reading `{cs}/changeset.md` — it lists every "
            f"MR under review (workspace, diff, source checkout), the author's intent, and "
            f"context-only related MRs.\n\n"
            f"Coding standards (read only if a finding depends on them): "
            f"`{cs}/.kiro/agents/steering/coding-standards-summary.md`, "
            f"`{cs}/.kiro/agents/steering/unit-test-guidelines.md`.\n\n"
            "## Reading budget — every tool call re-sends everything read so far, so:\n"
            "- Start from the diff (`full.diff`). Open source only to confirm or rule out a "
            "specific suspicion, never to browse.\n"
            "- Read LINE RANGES (about 40 lines around the code you need), not whole files; "
            "grep to find a symbol before reading around it.\n"
            "- Batch: put several reads in ONE read call, and several patterns in one grep.\n"
            "- Don't re-read a range you already have. Thoroughness comes first: cover "
            "everything your role asks for, just read efficiently while doing it.\n\n"
            f"**Write your output ONLY to `{out}`.** Do not write any other file.\n\n")


def find_roles(depth: str, multi: bool) -> list[str]:
    """quick: one precise pass, no verifier. Single MR: one recall-oriented finder covering logic
    AND tests, so the diff and checkout are read once (two finders re-read the same code and
    roughly double the cost). Multi-MR: narrow finders plus the cross-MR integration finder."""
    if depth == "quick":
        return ["all"]
    if not multi:
        return ["core"]
    return ["logic", "tests", "integration"]


def find_instruction(cs: Path, role: str, out: Path, works: list[MRWork]) -> str:
    keys = ", ".join(w.key for w in works)
    body = _prompt(f"find-{role}") + "\n\n" + _prompt("findings-contract").replace("{MR_KEYS}", keys)
    if role in ("logic", "all", "core"):
        body += "\n\n" + _prompt("assessment-contract").replace("{MR_KEYS}", keys)
    return stage_header(cs, f"find/{role}", out) + body


# --------------------------------------------------------------------------------------
# Parse / merge / apply
# --------------------------------------------------------------------------------------

def _cell(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("|", "/")).strip()


def resolve_mr(raw: str, works: list[MRWork]) -> MRWork | None:
    if len(works) == 1:
        return works[0]
    raw = raw.strip().strip("`").lower()
    for w in works:
        if raw == w.key.lower():
            return w
    m = re.search(r"(\d+)\s*$", raw)
    by_iid = [w for w in works if m and w.ref.mr_iid == int(m.group(1))]
    if len(by_iid) == 1:
        return by_iid[0]
    by_slug = [w for w in works if raw and (raw in w.key.lower() or w.ref.clone_slug.lower() in raw)]
    return by_slug[0] if len(by_slug) == 1 else None


def parse_findings(path: Path, works: list[MRWork], source: str) -> list[dict]:
    """Findings table: mr | file:line | dimension | severity | issue | suggested_fix | evidence."""
    out: list[dict] = []
    if not path.exists():
        return out
    for cells in parse_pipe_table(path.read_text(), "file:line"):
        if len(cells) < 5:
            continue
        mr_raw, loc, dim, sev, issue = cells[:5]
        sev = sev.upper().strip("[]* ")
        if sev not in mr_lib.SEVERITY_ORDER:
            continue
        w = resolve_mr(mr_raw, works)
        out.append({"mr": w.key if w else mr_raw, "location": loc.strip("`"),
                    "dimension": dim.lower().replace(" ", "_"), "severity": sev,
                    "issue": _cell(issue), "fix": _cell(cells[5]) if len(cells) > 5 else "",
                    "evidence": _cell(cells[6]) if len(cells) > 6 else "", "source": source})
    return out


def merge_candidates(cands: list[dict], works: list[MRWork], prefix: str = "F",
                     start: int = 1) -> tuple[list[dict], list[dict]]:
    """Ground each finding in ITS MR's changed lines, dedupe across finders, number them.

    Grounding before verification keeps the verifier's tokens on findings that could post at all.
    Dedup = same MR + same file + within 3 lines + same dimension (finders phrase issues
    differently, so exact-text dedup misses real duplicates); keep the higher severity."""
    by_key = {w.key: w for w in works}
    idx = {w.key: {k: set(v) for k, v in json.loads((w.ws / "changed-index.json").read_text()).items()}
           for w in works if (w.ws / "changed-index.json").exists()}
    kept: list[dict] = []
    ungrounded: list[dict] = []
    for c in cands:
        if c["mr"] not in by_key or not mr_lib.is_grounded(c["location"], idx.get(c["mr"], {})):
            ungrounded.append(c)
            continue
        loc = mr_lib.parse_location(c["location"])
        dup = None
        for k in kept:
            kl = mr_lib.parse_location(k["location"])
            if (k["mr"] == c["mr"] and loc and kl and kl[0] == loc[0]
                    and abs(kl[1] - loc[1]) <= 3 and k["dimension"] == c["dimension"]):
                dup = k
                break
        if dup is None:
            kept.append(dict(c))
            continue
        if mr_lib.SEVERITY_ORDER[c["severity"]] < mr_lib.SEVERITY_ORDER[dup["severity"]]:
            dup.update({kk: c[kk] for kk in ("severity", "issue", "fix", "evidence")})
        dup["source"] = ",".join(sorted(set(dup["source"].split(",")) | {c["source"]}))
    for i, c in enumerate(kept, start):
        c["id"] = f"{prefix}{i}"
    return kept, ungrounded


def candidates_table(cands: list[dict]) -> str:
    rows = ["| id | mr | file:line | dimension | severity | issue | suggested_fix | evidence |",
            "|---|---|---|---|---|---|---|---|"]
    rows += [f"| {c['id']} | {c['mr']} | `{c['location']}` | {c['dimension']} | {c['severity']} | "
             f"{c['issue']} | {c['fix']} | {c['evidence']} |" for c in cands]
    return "\n".join(rows)


def verify_instruction(cs: Path, cands: list[dict], out: Path, label: str) -> str:
    return (stage_header(cs, label, out) + _prompt("verify") + "\n\n## Candidates\n\n"
            + candidates_table(cands) + "\n")


def gap_instruction(cs: Path, verified_md: Path, out: Path, works: list[MRWork]) -> str:
    keys = ", ".join(w.key for w in works)
    return (stage_header(cs, "gap", out) + _prompt("gap")
            + f"\n\nThe verified findings so far (with verdicts) are in `{verified_md}`. "
              "Do NOT repeat any of them.\n\n"
            + _prompt("findings-contract").replace("{MR_KEYS}", keys))


def parse_verdicts(path: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for cells in parse_pipe_table(path.read_text(), "decision"):
        if len(cells) < 4:
            continue
        cid = cells[0].strip("` ").upper()
        try:
            conf = int(re.sub(r"[^\d]", "", cells[2]) or 0)
        except ValueError:
            conf = 0
        sev = cells[3].upper().strip("[]* ")
        out[cid] = {"decision": cells[1].upper().strip("* "), "confidence": conf,
                    "severity": sev if sev in mr_lib.SEVERITY_ORDER else "",
                    "reason": _cell(cells[4]) if len(cells) > 4 else ""}
    return out


def apply_verdicts(cands: list[dict], verdicts: dict[str, dict], threshold: int,
                   stage: str) -> tuple[list[dict], list[dict]]:
    missing = [c["id"] for c in cands if c["id"] not in verdicts]
    if cands and len(missing) > max(1, len(cands) // 5):
        raise SystemExit(f"STOP: {stage} returned no verdict for {len(missing)}/{len(cands)} "
                         f"finding(s) ({', '.join(missing[:10])}). Re-run with --from review --force.")
    kept, rejected = [], []
    for c in cands:
        v = verdicts.get(c["id"], {"decision": "UNVERIFIED", "confidence": 0, "severity": "",
                                   "reason": "verifier returned no verdict"})
        c = {**c, **{"decision": v["decision"], "confidence": v["confidence"],
                     "reason": v["reason"]}}
        if v["severity"]:
            c["severity"] = v["severity"]
        (kept if v["decision"] == "CONFIRMED" and v["confidence"] >= threshold else rejected).append(c)
    return kept, rejected


def parse_sections(path: Path) -> dict[str, str]:
    """Split a markdown file on `## ` headers -> {header: body}."""
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    cur = None
    for line in path.read_text().splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            cur = m.group(1).strip()
            out[cur] = ""
        elif cur is not None:
            out[cur] += line + "\n"
    return {k: v.strip() for k, v in out.items()}


def _subsection(body: str, name: str) -> str:
    m = re.search(rf"^###\s*{re.escape(name)}.*?$(.*?)(?=^###\s|\Z)", body,
                  re.MULTILINE | re.DOTALL | re.IGNORECASE)
    return _flatten_headers(m.group(1).strip()) if m else ""


def _flatten_headers(text: str) -> str:
    # finalize slices review.md on headers, so prose must not contain any
    return re.sub(r"^#+\s*(.+)$", r"**\1**", text, flags=re.MULTILINE)


def write_review_md(w: MRWork, kept: list[dict], prose: dict[str, str], cross: str) -> None:
    mine = [c for c in kept if c["mr"] == w.key]
    body = next((v for k, v in prose.items() if w.key.lower() in k.lower()), "")
    crit = sum(c["severity"] == "CRITICAL" for c in mine)
    high = sum(c["severity"] == "HIGH" for c in mine)
    rows = [f"| `{c['location']}` | {c['dimension']} | {c['severity']} | {c['issue']} | {c['fix']} |"
            for c in mine]
    text = "\n".join([
        "# --- REVIEW-EXEC ---", "schema_version: 2", "status: reviewed", "verdict: advisory",
        f"critical_count: {crit}", f"high_count: {high}", "# --- END REVIEW-EXEC ---", "",
        "## Semantic findings",
        "| file:line | dimension | severity | issue | suggested_fix |",
        "|---|---|---|---|---|", *rows, "",
        "## Business-logic alignment", _subsection(body, "Business-logic") or "_No assessment produced._", "",
        "## Regression risks", _subsection(body, "Regression") or "_None identified._", "",
    ] + (["## Cross-MR integration", _flatten_headers(cross), ""] if cross else []))
    (w.ws / "review.md").write_text(text)


# --------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------

def review_changeset(works: list[MRWork], workroot: Path, opts: Options) -> Path:
    cs = changeset_dir(workroot, works)
    cs.mkdir(parents=True, exist_ok=True)
    materialise_agent(cs)
    related = fetch_related(cs, opts.related)
    write_changeset_md(cs, works, opts.seed, related)
    multi = len(works) > 1 or bool(related)
    log(f"change set {cs.name}: {len(works)} MR(s), {len(related)} related, depth={opts.depth}")

    (cs / "credits.json").unlink(missing_ok=True)   # one book per run; reused stages re-read their logs

    # FIND
    roles = find_roles(opts.depth, multi)
    finds = [(f"find-{r}", opts.find_model, find_instruction(cs, r, cs / f"find-{r}.md", works),
              cs / f"find-{r}.md") for r in roles]
    run_stages(cs, opts, finds)

    raw = [c for r in roles for c in parse_findings(cs / f"find-{r}.md", works, r)]
    cands, ungrounded = merge_candidates(raw, works)
    (cs / "candidates.md").write_text(candidates_table(cands) + "\n")
    log(f"merge: {len(raw)} raw -> {len(cands)} candidate(s); {len(ungrounded)} ungrounded dropped")

    # VERIFY
    if opts.depth == "quick":
        kept, rejected = cands, []
    else:
        vout = cs / "verify.md"
        run_stages(cs, opts, [("verify", opts.verify_model,
                               verify_instruction(cs, cands, vout, "verify"), vout)] if cands else [])
        kept, rejected = apply_verdicts(cands, parse_verdicts(vout), opts.threshold, "verify") \
            if cands else ([], [])
        log(f"verify: {len(kept)} confirmed, {len(rejected)} rejected/low-confidence")

    # GAP (deep)
    if opts.depth == "deep":
        audit = cs / "verified.md"
        audit.write_text(candidates_table(kept + rejected) + "\n")
        gout = cs / "gap.md"
        run_stages(cs, opts, [("gap", opts.verify_model, gap_instruction(cs, audit, gout, works), gout)])
        gap, g_ungrounded = merge_candidates(parse_findings(gout, works, "gap"), works, prefix="G")
        ungrounded += g_ungrounded
        if gap:
            gv = cs / "verify-gap.md"
            run_stages(cs, opts, [("verify-gap", opts.verify_model,
                                   verify_instruction(cs, gap, gv, "verify-gap"), gv)])
            gk, gr = apply_verdicts(gap, parse_verdicts(gv), opts.threshold, "verify-gap")
            kept += gk
            rejected += gr
        log(f"gap: {len(gap)} new candidate(s)")

    # APPLY -> per-MR review.md (+ audit of what the verifier rejected)
    prose = {}
    for r in roles:
        prose.update(parse_sections(cs / f"find-{r}.md"))
    cross = prose.pop("Cross-MR integration", "")
    for w in works:
        write_review_md(w, kept, prose, cross)
        (w.ws / "verifier-dropped.json").write_text(json.dumps(
            [c for c in rejected if c["mr"] == w.key], indent=2))
    (cs / "ungrounded.json").write_text(json.dumps(ungrounded, indent=2))
    (cs / "stats.json").write_text(json.dumps({
        "raw": len(raw), "candidates": len(cands), "ungrounded": len(ungrounded),
        "confirmed": len(kept), "rejected": len(rejected), "roles": roles}, indent=2))
    log(f"wrote review.md for {len(works)} MR(s): {len(kept)} finding(s) kept")
    report = usage_report(cs, len(works))
    (cs / "credits.md").write_text(report + "\n")
    return cs


# --------------------------------------------------------------------------------------
# Self-test (offline, no model calls)
# --------------------------------------------------------------------------------------

def _selftest() -> None:
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        works = []
        for slug, iid, idx in (("svc-a", 1, {"src/A.ts": [10, 11, 12]}),
                               ("svc-b", 2, {"src/B.ts": [5]})):
            ws = root / f"{slug}-{iid}"
            ws.mkdir()
            (ws / "changed-index.json").write_text(json.dumps(idx))
            works.append(MRWork(mr_lib.parse_mr_url(
                f"https://gitlab.com/g/{slug}/-/merge_requests/{iid}"), ws, {"title": slug}))
        f = root / "find-logic.md"
        f.write_text(
            "## Findings\n| mr | file:line | dimension | severity | issue | suggested_fix | evidence |\n"
            "|---|---|---|---|---|---|---|\n"
            "| svc-a!1 | `src/A.ts:11` | regression | HIGH | breaks X | guard | A.ts:11 |\n"
            "| !1 | `src/A.ts:12` | regression | LOW | dup of above | - | - |\n"
            "| svc-b!2 | `src/B.ts:99` | business_logic | HIGH | off diff | - | - |\n"
            "| svc-b | `src/B.ts:5` | test_coverage | HIGH | no test | add | - |\n"
            "\n## svc-a!1\n### Business-logic alignment\nAC ok\n### Regression risks\nX\n"
            "\n## Cross-MR integration\nA emits field b reads\n")
        raw = parse_findings(f, works, "logic")
        cands, ung = merge_candidates(raw, works)
        assert [c["id"] for c in cands] == ["F1", "F2"], cands
        assert cands[0]["severity"] == "HIGH" and len(ung) == 1, (cands, ung)
        v = root / "verify.md"
        v.write_text("| id | decision | confidence | severity | reason |\n|---|---|---|---|---|\n"
                     "| F1 | CONFIRMED | 90 | HIGH | real |\n| F2 | REJECTED | 80 | HIGH | tested in B.test.ts |\n")
        kept, rej = apply_verdicts(cands, parse_verdicts(v), 70, "verify")
        assert [c["id"] for c in kept] == ["F1"] and [c["id"] for c in rej] == ["F2"]
        prose = parse_sections(f)
        cross = prose.pop("Cross-MR integration", "")
        for w in works:
            write_review_md(w, kept, prose, cross)
        ra = (works[0].ws / "review.md").read_text()
        assert "breaks X" in ra and "AC ok" in ra and "A emits field" in ra, ra
        assert "breaks X" not in (works[1].ws / "review.md").read_text()
        # finalize consumes the synthesized review.md unchanged
        import review_finalize
        plan = review_finalize.build(works[0].ws, nit_cap=10)
        assert plan["stats"]["llm"] == 1 and "Cross-MR integration" in plan["summary_note"], plan
    print("review_stages self-tests passed.")


if __name__ == "__main__":
    _selftest()
