#!/usr/bin/env python3
"""
review_static_gate.py — Step 6: the deterministic static gate over the CHANGED files.

This is the single biggest credit cut (docs/MR-REVIEW-ORCHESTRATION-AUDIT.md §1c): the existing
Power asks the LLM to *be* the linter over an ~80-item checklist — slow, non-reproducible, and the
exact failure mode where "it reports zero and misses one." Here, tools + greps establish those as
FACTS with file:line, so the LLM only does what code can't (semantic correctness, design).

Runs, scoped to the changed .ts files in a local clone:
  - eslint (repo config)          -> HIGH/LOW findings
  - prettier --check              -> LOW (formatting) findings
  - tsc --noEmit (whole project)  -> CRITICAL type errors, filtered to changed files
  - grep/AST rules for coding-guideline.md + unit-test-guidelines.md
  - a light await-in-loop perf heuristic, file-length, PSV-without-DSV flag

Emits `static-findings.json` (list the spine feeds the LLM as grounding + review_finalize dedups
against) and `static-findings.md` (human table). Exit code is advisory: 0 always unless --strict.

  python3 review_static_gate.py <clone_dir> --base develop --out /tmp/ws [--skip-tools]
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path

import mr_lib


@dataclass
class StaticFinding:
    location: str
    severity: str            # CRITICAL | HIGH | LOW
    dimension: str           # code_quality | performance | test_coverage
    rule: str
    issue: str
    source: str = "static"


# (rule_id, severity, dimension, regex, scope, message). scope: all | test | nontest
GREP_RULES: list[tuple] = [
    ("no-explicit-any", "HIGH", "code_quality",
     re.compile(r":\s*any\b"), "all", "`any` type — @typescript-eslint/no-explicit-any is an error rule."),
    ("no-unknown-in-test", "LOW", "test_coverage",
     re.compile(r":\s*unknown\b"), "test", "`unknown` in a test — use a precise type."),
    ("non-null-assertion", "HIGH", "code_quality",
     re.compile(r"[A-Za-z0-9_\)\]]\!(?:\.|\)|;|,|\s)"), "all",
     "Non-null assertion `!` — a lie to the compiler; use `?.` / `??`."),
    ("eslint-disable", "HIGH", "code_quality",
     re.compile(r"eslint-disable"), "all", "`eslint-disable` — fix the root cause or justify."),
    ("todo-without-ticket", "LOW", "code_quality",
     re.compile(r"//\s*(TODO|FIXME)(?!\s*\([A-Z][A-Z0-9]+-\d+\))"), "all",
     "TODO/FIXME without a ticket reference — use `// TODO(DMW-123):`."),
    ("console-log", "HIGH", "code_quality",
     re.compile(r"\bconsole\.(log|debug|info|warn|error)\s*\("), "nontest",
     "`console.*` in production code — use the structured `logger`."),
    ("raw-error-throw", "HIGH", "code_quality",
     re.compile(r"\bthrow\s+new\s+Error\s*\("), "nontest",
     "Raw `throw new Error(...)` — use a domain exception with an enum code + cause."),
    ("hardcoded-arn", "HIGH", "code_quality",
     re.compile(r"[\"']arn:aws:"), "all",
     "Hardcoded ARN — move to environment/config."),
    ("direct-dynamo-client", "HIGH", "code_quality",
     re.compile(r"new\s+(DynamoDBClient|DynamoClient|DocumentClient)\b"), "nontest",
     "Direct DynamoDB client in business code — go through DataAccessFactory / *Accessor."),
    # Unit-test guideline greps
    ("jest-mock", "HIGH", "test_coverage",
     re.compile(r"\bjest\.mock\s*\("), "test", "`jest.mock(` — use `jest.spyOn` at the boundary."),
    ("jest-fn", "HIGH", "test_coverage",
     re.compile(r"\bjest\.fn\s*\("), "test", "`jest.fn(` — use `jest.spyOn` at the boundary."),
    ("logger-assertion", "HIGH", "test_coverage",
     re.compile(r"expect\s*\(\s*[^)]*\blogger\."), "test",
     "Assertion on `logger.*` — logging is not behaviour under test."),
]


def _iter_lines(path: Path) -> list[str]:
    try:
        return path.read_text(errors="replace").splitlines()
    except Exception:
        return []


def _is_test(path: str) -> bool:
    return path.endswith(".test.ts") or path.endswith(".spec.ts")


def grep_findings(clone: Path, rel_files: list[str]) -> list[StaticFinding]:
    out: list[StaticFinding] = []
    for rel in rel_files:
        is_test = _is_test(rel)
        lines = _iter_lines(clone / rel)
        for rule_id, sev, dim, rx, scope, msg in GREP_RULES:
            if scope == "test" and not is_test:
                continue
            if scope == "nontest" and is_test:
                continue
            for i, line in enumerate(lines, 1):
                stripped = line.lstrip()
                if stripped.startswith("//") or stripped.startswith("*"):
                    continue  # ignore comment lines (except the TODO rule which targets comments)
                if rule_id == "todo-without-ticket":
                    if rx.search(line):
                        out.append(StaticFinding(f"{rel}:{i}", sev, dim, rule_id, msg))
                    continue
                if rx.search(line):
                    # A file-level `/* eslint-disable no-undef */` in a test file is a repo
                    # convention for jest globals (e.g. 583/584 WFE test files), not a defect.
                    if rule_id == "eslint-disable" and is_test and re.search(
                            r"eslint-disable\s+no-undef\s*\*/", line):
                        continue
                    out.append(StaticFinding(f"{rel}:{i}", sev, dim, rule_id, msg))
    return out


def await_in_loop_findings(clone: Path, rel_files: list[str]) -> list[StaticFinding]:
    """Light perf heuristic: flag `await` textually inside a for/while/forEach/map block."""
    loop_open = re.compile(r"\b(for|while)\s*\(|\.(forEach|map)\s*\(")
    out: list[StaticFinding] = []
    for rel in rel_files:
        if _is_test(rel):
            continue
        lines = _iter_lines(clone / rel)
        depth_stack: list[int] = []  # brace depths at which a loop opened
        brace = 0
        for i, line in enumerate(lines, 1):
            if loop_open.search(line) and "{" in line:
                depth_stack.append(brace)
            if depth_stack and re.search(r"\bawait\b", line):
                out.append(StaticFinding(
                    f"{rel}:{i}", "HIGH", "performance", "await-in-loop",
                    "`await` inside a loop — batch the calls or use Promise.all (N+1 risk)."))
            brace += line.count("{") - line.count("}")
            while depth_stack and brace <= depth_stack[-1]:
                depth_stack.pop()
    return out


def file_length_findings(clone: Path, rel_files: list[str], base: str = "") -> list[StaticFinding]:
    """Flag file length only when THIS MR caused it: a new file over the limit, or a file the MR
    pushed across a limit. A file that was already 2000 lines before the MR is existing debt, not
    an MR defect. Test files never get HIGH."""
    resolved = mr_lib.resolve_base_ref(base, lambda r: _ref_exists(clone, r)) if base else ""
    out: list[StaticFinding] = []
    for rel in rel_files:
        if not rel.endswith(".ts"):
            continue
        n = len(_iter_lines(clone / rel))
        before = 0
        if resolved:
            r = _sh(["git", "show", f"{resolved}:{rel}"], clone)
            before = len(r.stdout.splitlines()) if r.returncode == 0 else 0
        for limit, sev, msg in ((500, "HIGH", "must be split"), (300, "LOW", "consider splitting")):
            if n > limit:
                if before <= limit:  # new file, or this MR crossed the limit
                    sev = "LOW" if _is_test(rel) else sev
                    out.append(StaticFinding(f"{rel}:1", sev, "code_quality", "file-length",
                                             f"File is {n} lines (>{limit}) — {msg}."))
                break
    return out


def psv_dsv_flags(clone: Path, rel_files: list[str]) -> list[StaticFinding]:
    out: list[StaticFinding] = []
    for rel in rel_files:
        lines = _iter_lines(clone / rel)
        mentions_psv = any("ComponentTypeEnum.PSV" in l for l in lines)
        mentions_dsv = any("ComponentTypeEnum.DSV" in l for l in lines)
        if mentions_psv and not mentions_dsv:
            first = next((i for i, l in enumerate(lines, 1) if "ComponentTypeEnum.PSV" in l), 1)
            out.append(StaticFinding(
                f"{rel}:{first}", "LOW", "code_quality", "psv-without-dsv",
                "References PSV but not DSV — confirm whether DSV needs the same handling."))
    return out


# --------------------------------------------------------------------------------------
# Tool runners (best-effort; require node deps installed in the clone)
# --------------------------------------------------------------------------------------

def _sh(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


# ESLint core rules the TypeScript compiler already owns. typescript-eslint recommends turning these
# off for TS: they misfire on type-only names and on test-runner globals (`describe`/`it`/`expect`
# show as `no-undef` in every repo whose ESLint env lacks jest — a repo-config artifact, not an MR
# defect). tsc runs in this same gate, so a genuinely undefined name is still reported.
TS_OWNED_ESLINT_RULES = {"no-undef", "no-redeclare", "no-dupe-class-members", "no-unused-vars"}


def eslint_findings(clone: Path, rel_files: list[str]) -> list[StaticFinding]:
    if not rel_files:
        return []
    r = _sh(["npx", "--no-install", "eslint", "-f", "json", *rel_files], clone)
    out: list[StaticFinding] = []
    try:
        results = json.loads(r.stdout or "[]")
    except json.JSONDecodeError:
        return []
    for res in results:
        rel = res.get("filePath", "")
        try:
            rel = str(Path(rel).relative_to(clone))
        except ValueError:
            pass
        is_ts = rel.endswith((".ts", ".tsx"))
        for m in res.get("messages", []):
            rule = m.get("ruleId") or "eslint"
            if is_ts and rule in TS_OWNED_ESLINT_RULES:
                continue
            sev = "HIGH" if m.get("severity") == 2 else "LOW"
            line = m.get("line", 1)
            out.append(StaticFinding(f"{rel}:{line}", sev, "code_quality", rule,
                                     m.get("message", "eslint issue")))
    return out


def group_repeats(findings: list[StaticFinding]) -> list[StaticFinding]:
    """Collapse the same rule firing many times in one file into ONE finding on its first line.

    A new test file can trip one rule on dozens of lines; posting each as its own comment is the
    noise reviewers complained about. The grouped finding keeps the worst severity and lists lines.
    """
    groups: dict[tuple[str, str], list[StaticFinding]] = {}
    for f in findings:
        loc = mr_lib.parse_location(f.location)
        path = loc[0] if loc else f.location
        groups.setdefault((path, f.rule), []).append(f)
    order = {"CRITICAL": 0, "HIGH": 1, "LOW": 2}
    out: list[StaticFinding] = []
    for (path, _rule), fs in groups.items():
        if len(fs) == 1:
            out.append(fs[0])
            continue
        lines = sorted({(mr_lib.parse_location(f.location) or (path, 1))[1] for f in fs})
        worst = min(fs, key=lambda f: order.get(f.severity, 9))
        shown = ", ".join(str(n) for n in lines[:15]) + (" …" if len(lines) > 15 else "")
        out.append(StaticFinding(f"{path}:{lines[0]}", worst.severity, worst.dimension, worst.rule,
                                 f"{worst.issue} ({len(fs)} occurrences — lines {shown})"))
    return out


def prettier_findings(clone: Path, rel_files: list[str]) -> list[StaticFinding]:
    if not rel_files:
        return []
    r = _sh(["npx", "--no-install", "prettier", "--check", *rel_files], clone)
    if r.returncode == 0:
        return []
    out: list[StaticFinding] = []
    for line in (r.stderr or r.stdout).splitlines():
        m = re.search(r"\[warn\]\s+(\S+\.ts)", line)
        if m:
            out.append(StaticFinding(f"{m.group(1)}:1", "LOW", "code_quality", "prettier",
                                     "File is not prettier-formatted."))
    return out


_TSC_RE = re.compile(r"^(?P<file>[^\s(]+)\((?P<line>\d+),\d+\):\s+error\s+(?P<code>TS\d+):\s+(?P<msg>.+)$")


def tsc_findings(clone: Path, changed_set: set[str]) -> list[StaticFinding]:
    r = _sh(["npx", "--no-install", "tsc", "--noEmit"], clone)
    out: list[StaticFinding] = []
    for line in (r.stdout or "").splitlines():
        m = _TSC_RE.match(line.strip())
        if not m:
            continue
        f = m.group("file")
        if not any(f.endswith(c) or c.endswith(f) for c in changed_set):
            continue  # only surface type errors in the changed files
        out.append(StaticFinding(f"{f}:{m.group('line')}", "CRITICAL", "code_quality",
                                  m.group("code"), m.group("msg")))
    return out


def _ref_exists(clone: Path, ref: str) -> bool:
    """True if `ref` resolves to a commit in the clone (used to pick a valid diff base)."""
    return _sh(["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], clone).returncode == 0


def changed_ts_files(clone: Path, base: str) -> list[str]:
    resolved = mr_lib.resolve_base_ref(base, lambda r: _ref_exists(clone, r))
    if resolved != base:
        print(f"[static] base '{base}' is not a local ref — diffing against '{resolved}' instead.")
    r = _sh(["git", "diff", "--name-only", f"{resolved}...HEAD"], clone)
    if r.returncode != 0:
        # Never again read a git error as 'no changes' (the silent 0-changed-files bug).
        print(f"[static] WARNING: `git diff {resolved}...HEAD` failed (rc={r.returncode}): "
              f"{(r.stderr or '').strip()[:200]}")
    names = {l for l in r.stdout.splitlines() if l.strip()}
    r2 = _sh(["git", "diff", "--name-only", "HEAD"], clone)
    names |= {l for l in r2.stdout.splitlines() if l.strip()}
    return [n for n in sorted(names)
            if n.endswith(".ts") and not mr_lib.is_generated_or_vendored(n) and (clone / n).exists()]


def _load_changed_index(path: str | None) -> dict[str, set[int]]:
    if not path or not Path(path).exists():
        return {}
    return {k: set(v) for k, v in json.loads(Path(path).read_text()).items()}


# Rules that describe the whole file, not a line — keep them even off a changed line.
FILE_LEVEL_RULES = {"file-length"}


def scope_to_changed_lines(findings: list["StaticFinding"],
                           changed_index: dict[str, set[int]]) -> list["StaticFinding"]:
    """Keep only findings ON a changed line — 'review the diff, not the repo'.

    Without this the linter reports every PRE-EXISTING issue in a touched file (the 336-finding
    flood), which both drowns the LLM's grounding and risks inline comments on unchanged code.
    File-level rules (e.g. file-length) are always kept. If we have no changed-line index, keep all.
    """
    if not changed_index:
        return findings
    kept: list[StaticFinding] = []
    for f in findings:
        if f.rule in FILE_LEVEL_RULES:
            kept.append(f)
            continue
        loc = mr_lib.parse_location(f.location)
        if loc is None:
            continue
        path, line = loc
        for key, lines in changed_index.items():
            if (key == path or key.endswith("/" + path) or path.endswith("/" + key)
                    or key.endswith(path) or path.endswith(key)):
                if line in lines:
                    kept.append(f)
                    break
    return kept


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("clone")
    ap.add_argument("--base", default="develop")
    ap.add_argument("--out", required=True)
    ap.add_argument("--changed-index", help="changed-index.json — scope findings to changed lines")
    ap.add_argument("--skip-tools", action="store_true", help="grep-only (node deps not installed)")
    ap.add_argument("--strict", action="store_true", help="exit non-zero if any CRITICAL")
    args = ap.parse_args()

    clone = Path(args.clone).resolve()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    rel_files = changed_ts_files(clone, args.base)
    print(f"[static] {len(rel_files)} changed .ts file(s)")

    findings: list[StaticFinding] = []
    findings += grep_findings(clone, rel_files)
    findings += await_in_loop_findings(clone, rel_files)
    findings += file_length_findings(clone, rel_files, args.base)
    findings += psv_dsv_flags(clone, rel_files)

    if not args.skip_tools:
        findings += eslint_findings(clone, rel_files)
        findings += prettier_findings(clone, rel_files)
        findings += tsc_findings(clone, set(rel_files))

    # Scope to the diff so we flag what THIS MR changed, not pre-existing debt.
    before_n = len(findings)
    findings = scope_to_changed_lines(findings, _load_changed_index(args.changed_index))
    if before_n != len(findings):
        print(f"[static] scoped {before_n} -> {len(findings)} finding(s) on changed lines")
    findings = group_repeats(findings)

    # sort by severity then location
    order = {"CRITICAL": 0, "HIGH": 1, "LOW": 2}
    findings.sort(key=lambda f: (order.get(f.severity, 9), f.location))

    (out / "static-findings.json").write_text(json.dumps([asdict(f) for f in findings], indent=2))
    (out / "static-findings.md").write_text(
        "# Static gate findings (deterministic — already established)\n\n"
        "| file:line | rule | severity | issue |\n|---|---|---|---|\n"
        + "\n".join(f"| `{f.location}` | {f.rule} | {f.severity} | {f.issue} |" for f in findings)
        + f"\n\n**Total:** {len(findings)} finding(s).\n")

    crit = sum(1 for f in findings if f.severity == "CRITICAL")
    print(f"[static] {len(findings)} finding(s) ({crit} critical). Wrote static-findings.json/md")
    return 1 if (args.strict and crit) else 0


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 1:
        # self-test the pure detectors against synthetic content
        import tempfile
        d = Path(tempfile.mkdtemp())
        (d / "S.ts").write_text(
            "export class S {\n"
            "  run(x: any) {\n"                       # any -> HIGH
            "    for (const i of x) {\n"
            "      await this.call(i);\n"             # await-in-loop -> HIGH
            "    }\n"
            "    throw new Error('bad');\n"           # raw error -> HIGH
            "  }\n"
            "}\n")
        (d / "S.test.ts").write_text("it('works', () => { jest.mock('x'); });\n")  # jest.mock -> HIGH
        g = grep_findings(d, ["S.ts", "S.test.ts"]) + await_in_loop_findings(d, ["S.ts"])
        rules = {f.rule for f in g}
        assert "no-explicit-any" in rules, rules
        assert "await-in-loop" in rules, rules
        assert "raw-error-throw" in rules, rules
        assert "jest-mock" in rules, rules
        grouped = group_repeats([StaticFinding(f"S.test.ts:{n}", "LOW", "code_quality", "r", "x")
                                 for n in (3, 1, 2)] + [StaticFinding("S.ts:5", "HIGH", "code_quality", "r", "y")])
        assert len(grouped) == 2, grouped
        g0 = next(f for f in grouped if f.location.startswith("S.test.ts"))
        assert g0.location == "S.test.ts:1" and "3 occurrences" in g0.issue, g0
        print("review_static_gate self-tests passed:", sorted(rules))
        sys.exit(0)
    sys.exit(main())
