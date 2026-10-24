#!/usr/bin/env python3
"""
coverage_gate.py — scripted version of fixer Step 5's coverage check (deterministic, no LLM).

Why (docs/ORCHESTRATION-AUDIT.md §4): running jest twice and diffing per-file numbers is a
computation, not a judgment. The script drives BOTH runs itself and trusts nothing from the
fixer — it checks out the base branch for the baseline, restores the fix branch for the "after",
and enforces two rules from §5:

  1. No regression   — after-coverage >= before-coverage for every changed source file.
  2. Changes covered — every ADDED/CHANGED source line that is an executable statement must be
                       hit (coverage-final.json ∩ the git diff's added lines).

Per §5, falling short of an absolute legacy threshold is NOT a failure — only regression or an
uncovered new line is. Exit 0 = pass, non-zero = STOP.

    ./coverage_gate.py /tmp/kiro-bugfix/DT-46133/verification-workflow-engine \
        --base develop --test-cmd "pnpm exec jest --runInBand"

The jest-driving parts shell out; the parsing/decision logic is pure and unit-tested.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

METRICS = ("statements", "branches", "functions", "lines")


# --------------------------------------------------------------------------------------
# Pure parsing / decision logic (no jest, no git — unit-testable)
# --------------------------------------------------------------------------------------

def match_file(cov_keys: list[str], changed: str) -> str | None:
    """coverage-*.json keys are absolute paths; match a repo-relative changed file by suffix."""
    changed = changed.lstrip("./")
    for k in cov_keys:
        if k.replace("\\", "/").endswith("/" + changed) or k.replace("\\", "/").endswith(changed):
            return k
    return None


def parse_summary(summary: dict, changed_src: list[str]) -> dict[str, dict[str, float]]:
    """coverage-summary.json -> {changed_file: {metric: pct}}. Missing file => all-zero (new file)."""
    out: dict[str, dict[str, float]] = {}
    keys = [k for k in summary.keys() if k != "total"]
    for src in changed_src:
        key = match_file(keys, src)
        if key is None:
            out[src] = {m: 0.0 for m in METRICS}
        else:
            out[src] = {m: float(summary[key].get(m, {}).get("pct", 0.0)) for m in METRICS}
    return out


def uncovered_statement_lines(final: dict, changed_src: str) -> set[int]:
    """From coverage-final.json (istanbul), the set of source lines whose statement was NOT hit."""
    key = match_file(list(final.keys()), changed_src)
    if key is None:
        return set()
    entry = final[key]
    smap = entry.get("statementMap", {})
    s = entry.get("s", {})
    uncovered: set[int] = set()
    for sid, loc in smap.items():
        if s.get(sid, 0) == 0:
            start = loc.get("start", {}).get("line")
            end = loc.get("end", {}).get("line", start)
            if start:
                uncovered.update(range(start, (end or start) + 1))
    return uncovered


_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def added_lines_from_diff(diff_text: str) -> set[int]:
    """Parse `git diff` for one file -> set of NEW-side line numbers that were added/changed."""
    added: set[int] = set()
    new_line = 0
    for line in diff_text.splitlines():
        m = _HUNK_RE.match(line)
        if m:
            new_line = int(m.group(1))
            continue
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            added.add(new_line)
            new_line += 1
        elif line.startswith("-"):
            continue  # deletion: NEW-side pointer does not advance
        else:
            new_line += 1  # context line
    return added


def evaluate(before: dict, after: dict, uncovered_by_file: dict[str, set[int]],
             added_by_file: dict[str, set[int]]) -> list[str]:
    """Apply the two §5 rules; return a list of violation strings (empty == pass)."""
    violations: list[str] = []

    # Rule 1 — no regression, per changed file, per metric.
    for src, aft in after.items():
        bef = before.get(src, {m: 0.0 for m in METRICS})
        for m in METRICS:
            if aft[m] + 1e-9 < bef[m]:
                violations.append(
                    f"{src}: {m} regressed {bef[m]:.1f}% -> {aft[m]:.1f}%")

    # Rule 2 — every added/changed executable line must be covered.
    for src, added in added_by_file.items():
        uncovered = uncovered_by_file.get(src, set())
        missed = sorted(added & uncovered)
        if missed:
            violations.append(
                f"{src}: added lines not covered by tests: {missed}")

    return violations


# --------------------------------------------------------------------------------------
# jest + git driving (the side-effecting shell parts)
# --------------------------------------------------------------------------------------

def sh(cmd: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=check)


def changed_source_files(repo: Path, base: str) -> list[str]:
    """Changed, non-test .ts source files on this branch vs base (these are what we cover)."""
    r = sh(["git", "diff", "--name-only", f"{base}...HEAD"], repo, check=False)
    files = [l for l in r.stdout.splitlines() if l.endswith(".ts")
             and not l.endswith(".test.ts") and not l.endswith(".spec.ts")]
    return [f for f in files if (repo / f).exists()]


def run_jest(repo: Path, test_cmd: str, changed_src: list[str]) -> tuple[dict, dict]:
    """Run the test command with coverage scoped to changed files; return (summary, final)."""
    cov_from = [f"--collectCoverageFrom={s}" for s in changed_src]
    cmd = test_cmd.split() + ["--coverage",
                              "--coverageReporters=json-summary",
                              "--coverageReporters=json"] + cov_from
    sh(cmd, repo, check=False)  # non-zero (failing tests) handled by caller via Step 5 already
    summary = json.loads((repo / "coverage" / "coverage-summary.json").read_text())
    final = json.loads((repo / "coverage" / "coverage-final.json").read_text())
    return summary, final


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("--base", default="develop")
    ap.add_argument("--test-cmd", default="pnpm exec jest --runInBand")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    if not (repo / ".git").exists():
        print(f"FAIL: {repo} is not a git repo", file=sys.stderr)
        return 2

    changed_src = changed_source_files(repo, args.base)
    if not changed_src:
        print("[coverage] no changed source files — nothing to gate.")
        return 0
    print(f"[coverage] changed source files: {changed_src}")

    branch = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo).stdout.strip()
    stashed = "nothing to save" not in sh(["git", "stash", "push", "-u",
                                           "-m", "coverage-gate"], repo, check=False).stdout

    added_by_file = {
        src: added_lines_from_diff(
            sh(["git", "diff", f"{args.base}...HEAD", "--", src], repo, check=False).stdout)
        for src in changed_src
    }

    try:
        # AFTER — current (fix) branch.
        after_summary, after_final = run_jest(repo, args.test_cmd, changed_src)
        after = parse_summary(after_summary, changed_src)
        uncovered = {src: uncovered_statement_lines(after_final, src) for src in changed_src}

        # BEFORE — baseline on the base branch.
        sh(["git", "checkout", args.base], repo)
        try:
            before_summary, _ = run_jest(repo, args.test_cmd, changed_src)
            before = parse_summary(before_summary, changed_src)
        finally:
            sh(["git", "checkout", branch], repo)
    finally:
        if stashed:
            sh(["git", "stash", "pop"], repo, check=False)

    violations = evaluate(before, after, uncovered, added_by_file)

    print("\n[coverage] before -> after (per changed file):")
    for src in changed_src:
        b, a = before.get(src, {}), after.get(src, {})
        print(f"  {src}: lines {b.get('lines',0):.1f}% -> {a.get('lines',0):.1f}%, "
              f"branches {b.get('branches',0):.1f}% -> {a.get('branches',0):.1f}%")

    if violations:
        print("\n[coverage] STOP — coverage rules failed:")
        for v in violations:
            print("  ✗ " + v)
        return 1
    print("\n[coverage] PASS — no regression, and all added lines covered.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
