#!/usr/bin/env python3
"""
mr_lib.py — pure, unit-testable helpers for the MR-review spine.

No LLM, no network. This is the clerical work the existing Power made the model do token by token
(see docs/MR-REVIEW-ORCHESTRATION-AUDIT.md §1b): MR-URL parsing, Jira-key / Confluence / GitLab-MR
regexes, file->layer classification, the changed-line set, the grounding filter, verdict
computation, dedup, and the LOW-severity nit-cap.

Run `python3 mr_lib.py` to execute the self-tests at the bottom.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import quote, urlsplit

# --------------------------------------------------------------------------------------
# MR URL parsing
# --------------------------------------------------------------------------------------

# GitLab MR URLs look like:
#   https://gitlab.com/group/subgroup/repo/-/merge_requests/123
#   https://gitlab.example.com/org/repo/-/merge_requests/123/diffs
_MR_URL_RE = re.compile(
    r"^(?P<scheme>https?)://(?P<host>[^/]+)/(?P<path>.+?)/-/merge_requests/(?P<iid>\d+)"
)


@dataclass
class MRRef:
    host: str
    project_path: str          # e.g. "org/repo" (human path, for git + display)
    project_id: str            # URL-encoded path, e.g. "org%2Frepo" (for REST/MCP calls)
    mr_iid: int
    url: str

    @property
    def clone_slug(self) -> str:
        """Last path segment — used to name the temp clone dir."""
        return self.project_path.rstrip("/").split("/")[-1]


def parse_mr_url(url: str) -> MRRef:
    """Parse a GitLab MR URL into its components. Raises ValueError on anything unrecognised."""
    url = url.strip()
    m = _MR_URL_RE.match(url)
    if not m:
        raise ValueError(f"not a recognisable GitLab MR URL: {url!r}")
    project_path = m.group("path")
    return MRRef(
        host=m.group("host"),
        project_path=project_path,
        project_id=quote(project_path, safe=""),
        mr_iid=int(m.group("iid")),
        url=url,
    )


# --------------------------------------------------------------------------------------
# Text extraction regexes (Jira keys, Confluence pages, sibling GitLab MRs)
# --------------------------------------------------------------------------------------

_JIRA_KEY_RE = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d+)\b")
_CONFLUENCE_URL_RE = re.compile(
    r"https?://[^/\s]+/wiki/[^\s)\]]+", re.IGNORECASE
)
_GITLAB_MR_URL_RE = re.compile(
    r"https?://[^/\s]+/[^\s)\]]+?/-/merge_requests/\d+", re.IGNORECASE
)


def extract_jira_keys(text: str, prefixes: list[str] | None = None) -> list[str]:
    """Return de-duped Jira-style keys found in text, preserving first-seen order.

    `prefixes` (e.g. ["DMW", "DT", "VPT"]) restricts to known projects to avoid false positives
    like "UTF-8" or "SHA-256".
    """
    if not text:
        return []
    seen: list[str] = []
    allow = {p.upper() for p in prefixes} if prefixes else None
    for m in _JIRA_KEY_RE.finditer(text):
        key = m.group(1)
        proj = key.split("-", 1)[0]
        if allow is not None and proj not in allow:
            continue
        if key not in seen:
            seen.append(key)
    return seen


def extract_confluence_urls(text: str) -> list[str]:
    return _dedupe([m.group(0).rstrip(".,);") for m in _CONFLUENCE_URL_RE.finditer(text or "")])


def extract_mr_urls(text: str, exclude_iid: int | None = None) -> list[str]:
    """Sibling/related GitLab MR URLs mentioned in text (optionally excluding the current MR)."""
    urls = _dedupe([m.group(0).rstrip(".,);") for m in _GITLAB_MR_URL_RE.finditer(text or "")])
    if exclude_iid is None:
        return urls
    out = []
    for u in urls:
        try:
            if parse_mr_url(u).mr_iid == exclude_iid:
                continue
        except ValueError:
            pass
        out.append(u)
    return out


def _dedupe(items: list[str]) -> list[str]:
    seen: list[str] = []
    for it in items:
        if it not in seen:
            seen.append(it)
    return seen


# --------------------------------------------------------------------------------------
# File -> architecture-layer classification (mirrors coding-guideline §5 layering)
# --------------------------------------------------------------------------------------

_LAYER_RULES: list[tuple[str, re.Pattern]] = [
    ("test", re.compile(r"\.(test|spec)\.ts$")),
    ("controller", re.compile(r"Controller\.ts$")),
    ("service", re.compile(r"Service\.ts$")),
    ("accessor", re.compile(r"(Accessor|DynamoAccessor|Dao)\.ts$")),
    ("handler", re.compile(r"(Handler|Strategy|Rule|Predicate)\.ts$")),
    ("validator", re.compile(r"Validator\.ts$")),
    ("client", re.compile(r"(Client|ServiceClient)\.ts$")),
    ("pubsub", re.compile(r"(Producer|Consumer|PubSub)\.ts$")),
    ("entity", re.compile(r"(/Entity/|Entity\.ts$|\.entity\.ts$)")),
    ("constants", re.compile(r"Constants\.ts$")),
    ("utils", re.compile(r"Utils?\.ts$")),
    ("config", re.compile(r"(config|Config)\.ts$")),
]


def classify_layer(path: str) -> str:
    """Best-effort architecture-layer label for a changed file path."""
    for label, rx in _LAYER_RULES:
        if rx.search(path):
            return label
    if path.endswith(".ts"):
        return "other-ts"
    if re.search(r"\.(json|ya?ml)$", path):
        return "config-data"
    return "other"


def is_generated_or_vendored(path: str) -> bool:
    """Files a review should skip entirely (lockfiles, vendored, generated, build output)."""
    patterns = (
        "node_modules/", "dist/", "build/", "coverage/", ".min.", "/vendor/",
        "pnpm-lock.yaml", "package-lock.json", "yarn.lock", ".pb.ts", ".generated.",
    )
    return any(p in path for p in patterns)


# --------------------------------------------------------------------------------------
# Base-ref resolution (git) — the diff base is usually only a remote-tracking ref locally
# --------------------------------------------------------------------------------------

def resolve_base_ref(base: str, ref_exists: Callable[[str], bool]) -> str:
    """Resolve a review base (the MR's target-branch name) to a ref that exists in the clone.

    After `git clone` + `git fetch origin <source> <target>` + `git checkout <source>`, the target
    branch usually exists ONLY as a remote-tracking ref (`origin/<target>`), never as a local
    branch. A bare `git diff <target>...HEAD` then fails with 'unknown revision' and — because the
    callers don't check git's exit code — is silently read as ZERO changed files. That is exactly
    why the static/coverage gates reported "0 changed .ts file(s)" / "nothing to gate" for an MR
    whose target branch (`release`) differs from the clone's default branch (`develop`).

    Try the realistic candidates in order and return the first git can resolve; if none resolve,
    return `base` unchanged so the caller behaves exactly as before (and its exit-code guard logs).
    A local branch is preferred over `origin/<base>`, which is preferred over the last-fetched
    `FETCH_HEAD` (the spine fetches `origin <source> <target>`, so FETCH_HEAD == the target tip).
    """
    for candidate in (base, f"origin/{base}", "FETCH_HEAD"):
        if ref_exists(candidate):
            return candidate
    return base


# --------------------------------------------------------------------------------------
# Changed-line set (from unified diff) — powers scoping + the grounding filter
# --------------------------------------------------------------------------------------

_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def added_lines_from_diff(diff_text: str) -> set[int]:
    """New-side line numbers that were added/changed in a single file's unified diff."""
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
            continue
        else:
            new_line += 1
    return added


def changed_line_index(file_diffs: dict[str, str]) -> dict[str, set[int]]:
    """{path: unified_diff} -> {path: set(added/changed new-side line numbers)}."""
    return {path: added_lines_from_diff(diff) for path, diff in file_diffs.items()}


# --------------------------------------------------------------------------------------
# Grounding filter — drop any finding whose file:line is not inside the diff's changed lines
# --------------------------------------------------------------------------------------

_LOC_RE = re.compile(r"^(?P<path>[^\s:]+):(?P<line>\d+)")


def parse_location(location: str) -> tuple[str, int] | None:
    """Parse a `path/to/File.ts:42` location string into (path, line). None if unparseable."""
    m = _LOC_RE.match(location.strip().strip("`"))
    if not m:
        return None
    return m.group("path"), int(m.group("line"))


def is_grounded(location: str, changed_index: dict[str, set[int]], tolerance: int = 3) -> bool:
    """True if location falls on (or within `tolerance` lines of) a changed line in that file.

    Suffix-matches the path so `src/x/File.ts:42` matches a diff key of `File.ts` or a longer
    path. `tolerance` allows a comment on the hunk immediately adjacent to a changed line.
    """
    parsed = parse_location(location)
    if parsed is None:
        return False
    path, line = parsed
    for key, lines in changed_index.items():
        if key == path or key.endswith("/" + path) or path.endswith("/" + key) \
                or key.endswith(path) or path.endswith(key):
            if any(abs(line - cl) <= tolerance for cl in lines):
                return True
    return False


# --------------------------------------------------------------------------------------
# Findings model, dedup, nit-cap, verdict
# --------------------------------------------------------------------------------------

SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "LOW": 2}


@dataclass
class Finding:
    location: str              # "path/File.ts:42"
    severity: str              # CRITICAL | HIGH | LOW
    dimension: str             # code_quality | business_logic | regression | test_coverage | performance
    issue: str
    suggested_fix: str = ""
    source: str = "llm"        # llm | static | coverage | submission

    def key(self) -> tuple[str, str]:
        """Dedup key: same file:line + normalised issue text = duplicate."""
        norm = re.sub(r"\s+", " ", self.issue.lower()).strip()[:80]
        return (self.location.strip().strip("`"), norm)


def dedupe_findings(findings: list[Finding]) -> list[Finding]:
    """Drop duplicates by (location, issue); keep the highest-severity / first occurrence."""
    best: dict[tuple[str, str], Finding] = {}
    for f in findings:
        k = f.key()
        cur = best.get(k)
        if cur is None or SEVERITY_ORDER.get(f.severity, 9) < SEVERITY_ORDER.get(cur.severity, 9):
            best[k] = f
    return list(best.values())


def cap_low_severity(findings: list[Finding], cap: int = 10) -> tuple[list[Finding], int]:
    """Keep all CRITICAL/HIGH; cap LOW nits at `cap`. Returns (kept, dropped_count)."""
    high = [f for f in findings if f.severity in ("CRITICAL", "HIGH")]
    low = [f for f in findings if f.severity == "LOW"]
    dropped = max(0, len(low) - cap)
    return high + low[:cap], dropped


def sort_findings(findings: list[Finding]) -> list[Finding]:
    return sorted(findings, key=lambda f: (SEVERITY_ORDER.get(f.severity, 9), f.location))


def compute_verdict(findings: list[Finding]) -> str:
    """Driver-owned verdict — NEVER an approve/merge action, only advisory text.

    any CRITICAL -> blocked ; any HIGH -> needs_changes ; else approved_with_notes.
    """
    sevs = {f.severity for f in findings}
    if "CRITICAL" in sevs:
        return "blocked"
    if "HIGH" in sevs:
        return "needs_changes"
    return "approved_with_notes"


# --------------------------------------------------------------------------------------
# Self-tests
# --------------------------------------------------------------------------------------

if __name__ == "__main__":
    # MR URL parsing
    ref = parse_mr_url("https://gitlab.com/acme/group/payments-service/-/merge_requests/482/diffs")
    assert ref.project_path == "acme/group/payments-service", ref.project_path
    assert ref.project_id == "acme%2Fgroup%2Fpayments-service", ref.project_id
    assert ref.mr_iid == 482 and ref.clone_slug == "payments-service"
    print("parse_mr_url: ok ->", ref.project_path, ref.mr_iid)

    # Jira keys with prefix filtering (UTF-8 must not match)
    txt = "Implements DMW-1234 and DT-99; see UTF-8 note and SHA-256. Also DMW-1234 again."
    assert extract_jira_keys(txt, ["DMW", "DT"]) == ["DMW-1234", "DT-99"], extract_jira_keys(txt, ["DMW", "DT"])
    assert "UTF-8" not in extract_jira_keys(txt, ["DMW", "DT"])
    print("extract_jira_keys: ok ->", extract_jira_keys(txt, ["DMW", "DT"]))

    # Confluence + sibling MR extraction
    body = ("Design: https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Design . "
            "Backend MR https://gitlab.com/acme/backend/-/merge_requests/77 relates.")
    assert extract_confluence_urls(body) == ["https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Design"]
    assert extract_mr_urls(body) == ["https://gitlab.com/acme/backend/-/merge_requests/77"]
    print("extract confluence/mr: ok")

    # Layer classification
    assert classify_layer("src/modules/pay/PaymentController.ts") == "controller"
    assert classify_layer("src/modules/pay/PaymentService.ts") == "service"
    assert classify_layer("src/modules/pay/Tests/PaymentService.test.ts") == "test"
    assert is_generated_or_vendored("pnpm-lock.yaml")
    print("classify_layer: ok")

    # Base-ref resolution: local branch wins; else origin/<b>; else FETCH_HEAD; else unchanged.
    assert resolve_base_ref("develop", lambda r: r == "develop") == "develop"
    assert resolve_base_ref("release", lambda r: r == "origin/release") == "origin/release"
    assert resolve_base_ref("release", lambda r: r == "FETCH_HEAD") == "FETCH_HEAD"
    assert resolve_base_ref("release", lambda r: False) == "release"
    assert resolve_base_ref("release", lambda r: r in {"release", "origin/release"}) == "release"
    print("resolve_base_ref: ok")

    # Diff -> added lines
    diff = (
        "--- a/src/File.ts\n+++ b/src/File.ts\n"
        "@@ -10,3 +10,4 @@\n context\n-old\n+new1\n+new2\n more\n"
    )
    added = added_lines_from_diff(diff)
    assert added == {11, 12}, added
    print("added_lines_from_diff: ok ->", sorted(added))

    # Grounding filter
    idx = {"src/File.ts": {11, 12}}
    assert is_grounded("src/File.ts:12", idx)
    assert is_grounded("File.ts:13", idx)          # within tolerance
    assert not is_grounded("src/Other.ts:12", idx)
    assert not is_grounded("src/File.ts:999", idx)
    print("is_grounded: ok")

    # Dedup + nit-cap + verdict
    fs = [
        Finding("a.ts:1", "LOW", "code_quality", "naming could be clearer"),
        Finding("a.ts:1", "LOW", "code_quality", "Naming  could   be clearer"),  # dup
        Finding("b.ts:2", "CRITICAL", "business_logic", "AC not met"),
    ]
    deduped = dedupe_findings(fs)
    assert len(deduped) == 2, len(deduped)
    assert compute_verdict(deduped) == "blocked"
    kept, dropped = cap_low_severity([Finding(f"x.ts:{i}", "LOW", "code_quality", f"n{i}") for i in range(15)], cap=10)
    assert len(kept) == 10 and dropped == 5
    print("dedupe/nit-cap/verdict: ok")

    print("\nAll mr_lib self-tests passed.")
