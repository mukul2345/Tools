#!/usr/bin/env python3
"""
compliance_gate.py — scripted version of fixer Step 5.5 (the highest-value cut).

Why this exists (docs/ORCHESTRATION-AUDIT.md §4): asking an LLM to "grep my test files and
confirm zero matches of jest.mock" is exactly the failure mode where it reports zero and misses
one. This script runs eslint + prettier + the mechanical grep checks over the CHANGED files and
exits non-zero on any violation. It is cheaper than a model self-audit and strictly more reliable.

Run it as an independent re-check after the fixer node (defense in depth), or standalone:

    ./compliance_gate.py /tmp/kiro-bugfix/DT-46133/verification-workflow-engine [--base develop]

Exit code 0 = compliant. Non-zero = a real STOP (details printed).
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

# (label, regex, which files it applies to). Each is a mechanical §5.5 rule.
GREP_RULES = [
    ("jest.mock( used (use jest.spyOn)", re.compile(r"\bjest\.mock\s*\("), "test"),
    ("jest.fn( used (use jest.spyOn)", re.compile(r"\bjest\.fn\s*\("), "test"),
    (": any type", re.compile(r":\s*any\b"), "all"),
    (": unknown type", re.compile(r":\s*unknown\b"), "all"),
    ("assertion on logger.* call", re.compile(r"expect\s*\(\s*.*\blogger\."), "test"),
    ("new eslint-disable", re.compile(r"eslint-disable"), "all"),
]


def sh(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


def changed_files(repo: Path, base: str) -> list[Path]:
    """Files changed on this branch vs the base branch, plus any uncommitted working-tree changes."""
    names: set[str] = set()
    # committed on the branch
    r = sh(["git", "diff", "--name-only", f"{base}...HEAD"], repo)
    if r.returncode == 0:
        names.update(l for l in r.stdout.splitlines() if l.strip())
    # uncommitted (staged + unstaged)
    r = sh(["git", "diff", "--name-only", "HEAD"], repo)
    if r.returncode == 0:
        names.update(l for l in r.stdout.splitlines() if l.strip())
    return [repo / n for n in sorted(names) if n.endswith(".ts") and (repo / n).exists()]


def is_test(path: Path) -> bool:
    return path.name.endswith(".test.ts") or path.name.endswith(".spec.ts")


def grep_checks(files: list[Path]) -> list[str]:
    violations: list[str] = []
    for f in files:
        applies_test = is_test(f)
        try:
            lines = f.read_text().splitlines()
        except Exception:
            continue
        for label, rx, scope in GREP_RULES:
            if scope == "test" and not applies_test:
                continue
            for i, line in enumerate(lines, 1):
                if line.lstrip().startswith("//"):
                    continue  # ignore comments
                if rx.search(line):
                    violations.append(f"{f}:{i}  {label}  ->  {line.strip()}")
    return violations


def tool_checks(repo: Path, files: list[Path]) -> list[str]:
    """Run the repo's eslint + prettier on the changed files. Missing tool => reported, not fatal."""
    problems: list[str] = []
    rel = [str(f.relative_to(repo)) for f in files]
    if not rel:
        return problems

    eslint = sh(["npx", "--no-install", "eslint", *rel], repo)
    if eslint.returncode not in (0,):
        problems.append("eslint reported errors:\n" + (eslint.stdout or eslint.stderr).strip())

    prettier = sh(["npx", "--no-install", "prettier", "--check", *rel], repo)
    if prettier.returncode not in (0,):
        problems.append("prettier --check failed:\n" + (prettier.stdout or prettier.stderr).strip())
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("repo", help="path to the cloned repo with the fix applied")
    ap.add_argument("--base", default="develop", help="base branch to diff against")
    ap.add_argument("--skip-tools", action="store_true",
                    help="run only the grep checks (e.g. when node deps aren't installed)")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    if not (repo / ".git").exists():
        print(f"FAIL: {repo} is not a git repo", file=sys.stderr)
        return 2

    files = changed_files(repo, args.base)
    print(f"[compliance] {len(files)} changed .ts file(s) in {repo.name}")
    for f in files:
        print(f"  - {f.relative_to(repo)}")

    violations = grep_checks(files)
    if not args.skip_tools:
        violations += tool_checks(repo, files)

    if violations:
        print("\n[compliance] STOP — standards not met:")
        for v in violations:
            print("  ✗ " + v)
        return 1

    print("[compliance] PASS — coding + unit-test standards satisfied on changed files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
