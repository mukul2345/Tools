#!/usr/bin/env python3
"""
run_pipeline.py — the deterministic spine (replaces the Haiku orchestrator).

Design (see docs/ORCHESTRATION-AUDIT.md §6): a code driver owns the sequence and calls the LLM
at exactly TWO nodes — analyze and implement. Everything else (gather, KIRO-EXEC parse, repo
resolution, cloning, the gate, the compliance/coverage checks, autonomy branch, cleanup) is
deterministic and runs here with no model.

Each step writes a file to the per-issue workspace, so a re-run resumes at the first missing
output (checkpointing) instead of re-paying for completed work. Use --force to redo everything.

    ./run_pipeline.py DT-46133 --prefixes DT,VP [--force] [--from STEP]

This is a scaffold: the deterministic logic is real, and the two LLM nodes + the git/MR
side-effects are called out as clearly-marked integration seams (they shell out to kiro-cli and
already-existing scripts). Wire those to your real Kiro CLI invocation and you have the spine.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

import pipeline_lib as lib

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent


def _resolve_map() -> Path:
    """Locate component-repo-mapping-kiro.md in both the source-repo and deployed layouts.

    Source repo: <root>/scripts/ + <root>/agents/ are siblings.
    Deployed (deploy.sh): scripts -> ~/my-projects/jira-bug-fixer/scripts/, map -> ~/.kiro/agents/.
    Precedence: explicit env var, then the deployed ~/.kiro location, then the source-repo sibling.
    """
    candidates = [
        Path(p) for p in (
            os.environ.get("KIRO_BUGFIX_MAP", ""),
            str(Path.home() / ".kiro" / "agents" / "component-repo-mapping-kiro.md"),
            str(REPO_ROOT / "agents" / "component-repo-mapping-kiro.md"),
        ) if p
    ]
    for c in candidates:
        if c.exists():
            return c
    return candidates[-1]  # best-effort; loader will surface a clear error if missing


MAP_FILE = _resolve_map()


# --------------------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------------------

def log(msg: str) -> None:
    print(f"[spine] {msg}", flush=True)


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    """Run a shell command, streaming output. Raises on non-zero unless check=False."""
    log("$ " + " ".join(cmd))
    return subprocess.run(cmd, check=kw.pop("check", True), **kw)


def done(path: Path, force: bool) -> bool:
    """Checkpoint check: True if this step's output already exists and we're not forcing."""
    if path.exists() and not force:
        log(f"skip — {path.name} already present (checkpoint)")
        return True
    return False


# --------------------------------------------------------------------------------------
# LLM NODES (the only two model calls) — integration seam
# --------------------------------------------------------------------------------------

def call_agent(agent: str, prompt: str, headless: bool) -> None:
    """Invoke one Kiro agent as a subprocess. This is a node in the graph, not an orchestrator.

    The agent writes its hand-off file (findings.md / implementation.md) to the workspace; the
    driver reads and parses it afterward. Keep the prompt tight — the agent's run loop is its
    system prompt; here we only point it at inputs and the required output path.
    """
    base = ["kiro-cli", "chat", "--agent", agent]
    if headless:
        base += ["--no-interactive", "--trust-tools=read,write,shell", "--require-mcp-startup"]
    run(base + [prompt])


# --------------------------------------------------------------------------------------
# Pipeline steps
# --------------------------------------------------------------------------------------

def step_gather(issue: str, work: Path, prefixes: str, force: bool) -> None:
    out = work / "ticket-history.md"
    if done(out, force):
        return
    log("Phase 0 — gather ticket history (deterministic, 0 credits)")
    cmd = ["python3", str(HERE / "jira_gather.py"), issue, "--out", str(work)]
    if prefixes:
        cmd += ["--project-prefixes", prefixes]
    run(cmd)


def step_resolve(issue: str, work: Path) -> tuple[lib.RepoResolution, dict]:
    """Deterministic: parse KIRO-EXEC from the gathered ticket + resolve repos from the map.

    (Replaces analyzer Step 1/3 and fixer Step 1/2 clerical work.)
    """
    # jira_gather.py is assumed to persist the ticket description; fall back to the history md.
    ticket_txt = (work / "ticket.md")
    text = ticket_txt.read_text() if ticket_txt.exists() else (work / "ticket-history.md").read_text()

    try:
        kiro_exec = lib.parse_exec_block(text, "KIRO-EXEC")
    except ValueError:
        sys.exit("STOP: ticket is not agent-ready (no parseable KIRO-EXEC block). "
                 "Post a Jira comment and halt.")

    components = _read_components(work)
    repo_map = lib.load_component_map(MAP_FILE)
    res = lib.resolve_repos(components, kiro_exec, repo_map)

    if res.unknown:
        sys.exit(f"STOP: unmapped components/repos {res.unknown} — add them to the map, don't guess.")
    if not res.code_repos:
        sys.exit("STOP: zero code repos resolved — comment and halt.")

    log(f"resolved repos: {[e.repo for e in res.code_repos]} "
        f"(ignored areas: {res.ignored_areas})")
    return res, kiro_exec


def _read_components(work: Path) -> list[str]:
    """Components come from the gather step's json sidecar (native Jira field)."""
    import json
    sidecar = work / "ticket-history.json"
    if sidecar.exists():
        data = json.loads(sidecar.read_text())
        return data.get("components", [])
    return []


def step_analyze(issue: str, work: Path, headless: bool, force: bool) -> None:
    out = work / "findings.md"
    if done(out, force):
        return
    log("LLM NODE 1 — analyze (Opus). Emits findings.md with a FINDINGS-EXEC block.")
    call_agent(
        "jira-bug-analyzer",
        f"Analyze Jira issue {issue}. Ticket history: {work}/ticket-history.md. "
        f"Follow your run loop, then write {work}/findings.md with the FINDINGS-EXEC block "
        f"(alignment, package_change, feature_flag) plus the tables and prose per the contract.",
        headless,
    )


def gate(work: Path) -> dict:
    """THE GATE (no LLM): honor the fix only when FINDINGS-EXEC.alignment == aligned."""
    findings = lib.read_findings_gate(work / "findings.md")
    alignment = findings.get("alignment")
    if alignment != "aligned":
        log(f"GATE: alignment={alignment} — analyzer halted or mismatched. "
            f"Fixer will NOT run; a human should review the Jira comment.")
        sys.exit(0)
    log("GATE: aligned — proceeding to the fixer.")
    return findings


def step_fix(issue: str, work: Path, headless: bool, force: bool) -> None:
    out = work / "implementation.md"
    if done(out, force):
        return
    log("LLM NODE 2 — implement (Sonnet). Makes the code change + emits implementation.md.")
    call_agent(
        "jira-bug-fixer",
        f"Fix Jira issue {issue}. Spec: {work}/findings.md (spec_source=analyzer). "
        f"Follow your run loop; write {work}/implementation.md with the IMPL-EXEC block "
        f"(status, tests_passed), the coverage table, MR-description blocks, and the diff.",
        headless,
    )


def step_coverage(work: Path, res: lib.RepoResolution, kiro_exec: dict) -> None:
    """Scripted §5 coverage check — jest run twice by the script (no trust in the fixer).

    No-regression + all-added-lines-covered, per changed source file. Non-zero exit == STOP.
    """
    impl = lib.read_impl_status(work / "implementation.md")
    if impl.get("status") != "implemented":
        log(f"fixer status={impl.get('status')} — skipping coverage gate.")
        sys.exit(0)
    base = kiro_exec.get("base_branch", "develop")
    for entry in res.code_repos:
        clone = work / entry.repo
        if not clone.exists():
            continue
        log(f"coverage gate — {entry.repo} (base={base})")
        run(["python3", str(HERE / "coverage_gate.py"), str(clone), "--base", base])


def step_compliance(work: Path, res: lib.RepoResolution) -> None:
    """Independent scripted re-check of §5.5 — defense in depth, and the biggest credit cut.

    Even though the fixer claims compliance, the driver verifies it mechanically with a script
    (an LLM self-grepping can silently miss a match). Non-zero exit here == a real STOP.
    """
    impl = lib.read_impl_status(work / "implementation.md")
    if impl.get("status") != "implemented":
        log(f"fixer status={impl.get('status')} — not implemented (stop_reason: "
            f"{impl.get('stop_reason')}). Nothing to verify; surfacing the STOP.")
        sys.exit(0)

    for entry in res.code_repos:
        clone = work / entry.repo
        if not clone.exists():
            continue
        log(f"compliance gate — {entry.repo}")
        run(["python3", str(HERE / "compliance_gate.py"), str(clone)])


def step_report(issue: str, work: Path) -> None:
    log(f"DONE {issue}. Artifacts in {work}: findings.md, implementation.md.")
    log("MR/Jira side-effects were performed by the fixer node (it holds the GitLab/Jira MCP).")


# --------------------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------------------

STEPS = ["gather", "resolve", "analyze", "gate", "fix", "coverage", "compliance", "report"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("issue")
    ap.add_argument("--prefixes", default="")
    ap.add_argument("--force", action="store_true", help="ignore checkpoints; redo every step")
    ap.add_argument("--from", dest="from_step", choices=STEPS, help="resume from this step")
    ap.add_argument("--headless", action="store_true", help="run agents non-interactively")
    args = ap.parse_args()

    work = Path(f"/tmp/kiro-bugfix/{args.issue}")
    work.mkdir(parents=True, exist_ok=True)
    log(f"issue={args.issue} workspace={work}")

    start = STEPS.index(args.from_step) if args.from_step else 0
    force = args.force

    res: lib.RepoResolution | None = None
    kiro_exec: dict = {}

    def ensure_resolved() -> None:  # for resuming mid-pipeline (e.g. --from coverage)
        nonlocal res, kiro_exec
        if res is None:
            res, kiro_exec = step_resolve(args.issue, work)

    for name in STEPS[start:]:
        if name == "gather":
            step_gather(args.issue, work, args.prefixes, force)
        elif name == "resolve":
            res, kiro_exec = step_resolve(args.issue, work)
        elif name == "analyze":
            step_analyze(args.issue, work, args.headless, force)
        elif name == "gate":
            gate(work)
        elif name == "fix":
            step_fix(args.issue, work, args.headless, force)
        elif name == "coverage":
            ensure_resolved()
            step_coverage(work, res, kiro_exec)
        elif name == "compliance":
            ensure_resolved()
            step_compliance(work, res)
        elif name == "report":
            step_report(args.issue, work)


if __name__ == "__main__":
    main()
