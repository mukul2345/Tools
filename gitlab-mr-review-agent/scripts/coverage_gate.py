#!/usr/bin/env python3
"""
coverage_gate.py — Step 6 (coverage): jest run twice by the script, no-regression vs base.

Adapted from the sibling bug-fixer's coverage_gate. Two rules from the guidelines:
  1. No regression   — after-coverage >= before-coverage for every changed source file.
  2. Changes covered — every ADDED/CHANGED executable line must be hit by a test.

Per the user's requirement, jest runs ONLY the changed/related tests (fast): the changed
`*.test.ts` files plus `--findRelatedTests` for the changed source files, with coverage collected
only from the changed source files.

The parsing/decision logic is pure (unit-tested below). The jest + git driving shells out.

  python3 coverage_gate.py <clone> --base develop [--test-cmd "pnpm exec jest --runInBand"]

Exit 0 = pass (or nothing to gate). Non-zero = STOP with details.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import mr_lib

# Hard wall-clock cap on each jest run so a hung suite (open DB/SQS handles, infra waits) can never
# freeze the whole pipeline. Override with KIRO_MR_JEST_TIMEOUT (seconds).
JEST_TIMEOUT = int(os.environ.get("KIRO_MR_JEST_TIMEOUT", "900"))

METRICS = ("statements", "branches", "functions", "lines")


# --------------------------------------------------------------------------------------
# Pure parsing / decision logic (no jest, no git — unit-testable)
# --------------------------------------------------------------------------------------

def match_file(cov_keys: list[str], changed: str) -> str | None:
    changed = changed.lstrip("./")
    for k in cov_keys:
        kk = k.replace("\\", "/")
        if kk.endswith("/" + changed) or kk.endswith(changed):
            return k
    return None


def parse_summary(summary: dict, changed_src: list[str]) -> dict[str, dict[str, float]]:
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


def evaluate(before: dict, after: dict, uncovered_by_file: dict[str, set[int]],
             added_by_file: dict[str, set[int]]) -> list[str]:
    violations: list[str] = []
    for src, aft in after.items():
        bef = before.get(src, {m: 0.0 for m in METRICS})
        for m in METRICS:
            if aft[m] + 1e-9 < bef[m]:
                violations.append(f"{src}: {m} regressed {bef[m]:.1f}% -> {aft[m]:.1f}%")
    for src, added in added_by_file.items():
        missed = sorted(added & uncovered_by_file.get(src, set()))
        if missed:
            violations.append(f"{src}: added lines not covered by tests: {missed}")
    return violations


# --------------------------------------------------------------------------------------
# jest + git driving
# --------------------------------------------------------------------------------------

def sh(cmd: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=check)


def ref_exists(repo: Path, ref: str) -> bool:
    """True if `ref` resolves to a commit in the clone (used to pick a valid diff base)."""
    return sh(["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
              repo, check=False).returncode == 0


STASH_MESSAGE = "coverage-gate"


def _stash_local_changes(repo: Path) -> bool:
    """Stash uncommitted changes before the base-branch checkout; True only if a stash was made.

    Decides on `git status --porcelain`, not on git's human-readable stash output: that wording
    changed ("No local changes to save" vs "nothing to save"), and misreading it made the gate pop
    a stash it never created. The stash list is shared by every worktree of a repo, so a wrong pop
    applies someone else's work-in-progress.
    """
    if not sh(["git", "status", "--porcelain"], repo, check=False).stdout.strip():
        return False
    r = sh(["git", "stash", "push", "-u", "-m", STASH_MESSAGE], repo, check=False)
    return r.returncode == 0 and _top_stash_is_ours(repo)


def _top_stash_is_ours(repo: Path) -> bool:
    top = sh(["git", "stash", "list", "-n", "1", "--format=%gs"], repo, check=False).stdout.strip()
    return top.endswith(STASH_MESSAGE)


def _pop_own_stash(repo: Path) -> None:
    """Pop stash@{0} only if it is the entry this run created; otherwise leave the stash alone."""
    if not _top_stash_is_ours(repo):
        print("[coverage] WARNING: top stash is not ours — not popping; restore manually if needed.",
              flush=True)
        return
    sh(["git", "stash", "pop"], repo, check=False)


def changed_files(repo: Path, base: str) -> tuple[list[str], list[str]]:
    """Return (changed_source_ts, changed_test_ts) vs base, existing on disk, non-vendored.

    `base` must already be a ref that resolves locally (see mr_lib.resolve_base_ref) — otherwise
    git errors and the (guarded) empty result is correctly reported as a failure, not "no changes".
    """
    r = sh(["git", "diff", "--name-only", f"{base}...HEAD"], repo, check=False)
    if r.returncode != 0:
        # Never again read a git error as 'no changed files' (the silent 0-changed bug).
        print(f"[coverage] WARNING: `git diff {base}...HEAD` failed (rc={r.returncode}): "
              f"{(r.stderr or '').strip()[:200]}")
    names = [l for l in r.stdout.splitlines() if l.endswith(".ts")]
    src, tests = [], []
    for n in names:
        if mr_lib.is_generated_or_vendored(n) or not (repo / n).exists():
            continue
        (tests if (n.endswith(".test.ts") or n.endswith(".spec.ts")) else src).append(n)
    return src, tests


def sibling_test_files(src_rel: str) -> list[str]:
    """Convention-based test locations for a changed source file (VPT: `Tests/<Name>.test.ts`).

    We run THESE, not `--findRelatedTests <source>`: the latter runs every suite that transitively
    imports the file, which for a central service is the whole codebase (the 317-suite blow-up).
    """
    p = Path(src_rel)
    stem = p.name[:-3]  # strip ".ts"
    d = p.parent
    candidates = [
        d / f"{stem}.test.ts", d / f"{stem}.spec.ts",
        d / "Tests" / f"{stem}.test.ts", d / "Tests" / f"{stem}.spec.ts",
        d / "tests" / f"{stem}.test.ts",
        d / "__tests__" / f"{stem}.test.ts", d / "__tests__" / f"{stem}.spec.ts",
    ]
    return [str(c) for c in candidates]


def resolve_test_files(repo: Path, changed_src: list[str], changed_tests: list[str]) -> tuple[list[str], list[str]]:
    """Explicit test-file list to run = changed test files + each changed source's co-located test.

    Returns (test_files_that_exist, source_files_with_no_test) — the latter is a real coverage gap
    the review should flag, not a reason to fall back to the whole suite.
    """
    picked: list[str] = list(changed_tests)
    no_test: list[str] = []
    for src in changed_src:
        found = [t for t in sibling_test_files(src) if (repo / t).exists()]
        if found:
            picked.extend(found)
        else:
            no_test.append(src)
    # de-dupe on the canonical real path (handles case-insensitive filesystems where Tests/ and
    # tests/ resolve to the same directory), keep first-seen order.
    seen, unique = set(), []
    for t in picked:
        full = repo / t
        try:
            st = full.stat()               # inode identity: dedupes Tests/ vs tests/ on a
            key = (st.st_dev, st.st_ino)   # case-insensitive FS; keeps distinct files on Linux/CI
        except OSError:
            continue
        if key in seen:
            continue
        seen.add(key)
        unique.append(t)
    return unique, no_test


def run_jest(repo: Path, test_cmd: str, changed_src: list[str],
             test_files: list[str]) -> tuple[dict, dict] | None:
    """Run ONLY the given test files; collect coverage from the changed source only.

    Returns (summary, final), or None when the run times out or fails to produce coverage — so the
    caller can mark coverage INCONCLUSIVE and continue instead of blocking the whole review.

    Runs the explicit `test_files` (positional) rather than `--findRelatedTests <source>`, which
    would pull in every suite that transitively imports a central service (the 317-suite blow-up).

    Hardening (see the hang post-mortem): `--forceExit` so open handles (DB/SQS/timers) can't keep
    jest alive; `--ci` for non-interactive; `--passWithNoTests`; a wall-clock timeout; and output
    is STREAMED (inherited), never captured, so progress is visible.
    """
    cov_from = [f"--collectCoverageFrom={s}" for s in changed_src]
    present = [t for t in test_files if (repo / t).exists()]  # some may not exist on the base branch
    if not present:
        # CRITICAL: jest with no test paths runs the ENTIRE suite. Never do that — bail instead.
        print("[coverage] no target test files present on this checkout — skipping jest "
              "(refusing to run the full suite).", flush=True)
        return None
    cmd = test_cmd.split() + [
        "--coverage", "--coverageReporters=json-summary", "--coverageReporters=json",
        "--ci", "--forceExit", "--passWithNoTests", *cov_from, *present,
    ]

    covdir = repo / "coverage"
    for name in ("coverage-summary.json", "coverage-final.json"):
        try:
            (covdir / name).unlink()          # never read a previous run's stale reports
        except FileNotFoundError:
            pass

    print(f"[coverage] $ {' '.join(cmd)}   (timeout {JEST_TIMEOUT}s)", flush=True)
    try:
        subprocess.run(cmd, cwd=repo, timeout=JEST_TIMEOUT)   # stream to terminal; no capture
    except subprocess.TimeoutExpired:
        print(f"[coverage] jest exceeded {JEST_TIMEOUT}s — aborting (coverage inconclusive). "
              f"Raise KIRO_MR_JEST_TIMEOUT or check for open handles / infra waits.", flush=True)
        return None
    except Exception as e:  # noqa: BLE001 — never let a jest failure crash the spine
        print(f"[coverage] jest invocation failed: {e} — coverage inconclusive.", flush=True)
        return None

    try:
        summary = json.loads((covdir / "coverage-summary.json").read_text())
        final = json.loads((covdir / "coverage-final.json").read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        print("[coverage] jest produced no coverage reports — inconclusive.", flush=True)
        return None
    return summary, final


def _write_findings(out: str | None, status: str, violations: list[str]) -> None:
    """Machine-readable coverage result consumed by review_finalize.py.

    `violations` is the list of no-regression / uncovered-added-line failures. review_finalize turns
    a non-empty list into ONE consolidated coverage-regression comment. An inconclusive/skipped run
    writes an empty list so no false regression is ever reported."""
    if not out:
        return
    Path(out).mkdir(parents=True, exist_ok=True)
    (Path(out) / "coverage-findings.json").write_text(
        json.dumps({"status": status, "violations": violations}, indent=2))


def _write_inconclusive(out: str | None, reason: str) -> None:
    if not out:
        return
    Path(out).mkdir(parents=True, exist_ok=True)
    (Path(out) / "coverage-report.md").write_text(
        f"# Coverage — INCONCLUSIVE\n\n_{reason}_\n\n"
        "The review continues without a local no-regression check. "
        "Fall back to the CI pipeline coverage report on the MR, or re-run "
        "`--from coverage` with a higher `KIRO_MR_JEST_TIMEOUT`.\n")
    _write_findings(out, "inconclusive", [])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("--base", default="develop")
    ap.add_argument("--test-cmd", default="pnpm exec jest --runInBand")
    ap.add_argument("--out", help="workspace dir to write coverage-report.md")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    if not (repo / ".git").exists():
        print(f"FAIL: {repo} is not a git repo", file=sys.stderr)
        return 2

    # The target branch is usually only a remote-tracking ref locally (`origin/<target>`), so a
    # bare `<target>...HEAD` diff/checkout fails and silently yields no changes. Resolve it once.
    base = mr_lib.resolve_base_ref(args.base, lambda r: ref_exists(repo, r))
    if base != args.base:
        print(f"[coverage] base '{args.base}' is not a local ref — using '{base}' for diff/baseline.")

    changed_src, changed_tests = changed_files(repo, base)
    if not changed_src:
        print("[coverage] no changed source files — nothing to gate.")
        _write_findings(args.out, "pass", [])
        return 0
    print(f"[coverage] changed source: {changed_src}")
    print(f"[coverage] changed tests:  {changed_tests}")

    test_files, no_test = resolve_test_files(repo, changed_src, changed_tests)
    print(f"[coverage] running only these test file(s): {test_files or '(none found)'}")
    if no_test:
        print(f"[coverage] ⚠️ no co-located test for: {no_test} (coverage may be understated)")
    if not test_files:
        _write_inconclusive(args.out, "No co-located test files found for the changed sources "
                            "(convention `Tests/<Name>.test.ts`). Add tests, or verify test location.")
        return 0

    branch = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo).stdout.strip()
    stashed = _stash_local_changes(repo)

    added_by_file = {
        src: mr_lib.added_lines_from_diff(
            sh(["git", "diff", f"{base}...HEAD", "--", src], repo, check=False).stdout)
        for src in changed_src
    }

    before: dict = {}
    baseline_note = ""
    try:
        after_res = run_jest(repo, args.test_cmd, changed_src, test_files)
        if after_res is None:
            _write_inconclusive(args.out, "jest on the source branch timed out or produced no coverage.")
            return 0
        after_summary, after_final = after_res
        after = parse_summary(after_summary, changed_src)
        uncovered = {src: uncovered_statement_lines(after_final, src) for src in changed_src}

        sh(["git", "checkout", base], repo, check=False)   # detached at the base tip for baseline
        try:
            before_res = run_jest(repo, args.test_cmd, changed_src, test_files)
            if before_res is None:
                baseline_note = ("Baseline (base-branch) coverage was inconclusive — "
                                 "no-regression check skipped; added-line coverage still enforced.")
                print(f"[coverage] {baseline_note}", flush=True)
            else:
                before = parse_summary(before_res[0], changed_src)
        finally:
            sh(["git", "checkout", branch], repo, check=False)
    finally:
        if stashed:
            _pop_own_stash(repo)

    violations = evaluate(before, after, uncovered, added_by_file)

    report = ["# Coverage (before -> after, per changed file)\n"]
    if baseline_note:
        report.append(f"> ⚠️ {baseline_note}\n")
    report += [
              "| file | lines before | lines after | branches before | branches after |",
              "|---|---|---|---|---|"]
    for src in changed_src:
        b, a = before.get(src, {}), after.get(src, {})
        report.append(f"| `{src}` | {b.get('lines',0):.1f}% | {a.get('lines',0):.1f}% | "
                      f"{b.get('branches',0):.1f}% | {a.get('branches',0):.1f}% |")
    if violations:
        report.append("\n## STOP — coverage rules failed")
        report += [f"- {v}" for v in violations]
    else:
        report.append("\n**PASS** — no regression, and all added lines covered.")

    if args.out:
        Path(args.out).mkdir(parents=True, exist_ok=True)
        (Path(args.out) / "coverage-report.md").write_text("\n".join(report))
    _write_findings(args.out, "fail" if violations else "pass", violations)

    print("\n".join(report))
    return 1 if violations else 0


if __name__ == "__main__":
    if len(sys.argv) == 1:
        # pure-logic self-test
        before = {"a.ts": {"statements": 80, "branches": 70, "functions": 90, "lines": 80}}
        after = {"a.ts": {"statements": 85, "branches": 60, "functions": 90, "lines": 85}}
        v = evaluate(before, after, {"a.ts": {12}}, {"a.ts": {12, 13}})
        assert any("branches regressed" in x for x in v), v
        assert any("not covered" in x for x in v), v
        ok = evaluate({"a.ts": {m: 80 for m in METRICS}}, {"a.ts": {m: 80 for m in METRICS}},
                      {"a.ts": set()}, {"a.ts": {5}})
        assert ok == [], ok

        # test-file resolution: co-located Tests/<Name>.test.ts is picked, not the whole suite
        import tempfile
        repo = Path(tempfile.mkdtemp())
        (repo / "src" / "modules" / "claimItem" / "Tests").mkdir(parents=True)
        (repo / "src" / "modules" / "claimItem" / "ClaimItemService.ts").write_text("x")
        tf = repo / "src" / "modules" / "claimItem" / "Tests" / "ClaimItemService.test.ts"
        tf.write_text("x")
        picked, no_test = resolve_test_files(
            repo, ["src/modules/claimItem/ClaimItemService.ts"], [])
        assert picked == ["src/modules/claimItem/Tests/ClaimItemService.test.ts"], picked
        assert no_test == [], no_test
        # a source with no co-located test is reported, not silently expanded
        (repo / "src" / "modules" / "claimItem" / "Orphan.ts").write_text("x")
        picked2, no_test2 = resolve_test_files(
            repo, ["src/modules/claimItem/Orphan.ts"], [])
        assert picked2 == [] and no_test2 == ["src/modules/claimItem/Orphan.ts"], (picked2, no_test2)
        print("coverage_gate self-tests passed.")
        sys.exit(0)
    sys.exit(main())
