#!/usr/bin/env python3
"""
pipeline_lib.py — deterministic parsing helpers for the bug-fix spine.

Pure functions, no LLM, no network. Everything here is the "clerical" work the models
currently do by hand (see docs/ORCHESTRATION-AUDIT.md §2, §3): parsing the KIRO-EXEC block,
loading the component->repo map, resolving repos, and reading the *-EXEC hand-off blocks the
two LLM nodes emit.

Only dependency is PyYAML (already used by the agents' YAML blocks). If you want zero deps,
the *-EXEC blocks are flat key:value and can be parsed with the regex fallback below; the
component map's fenced ```yaml blocks do need a YAML parser.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import yaml  # PyYAML
except ImportError:  # pragma: no cover
    yaml = None


# --------------------------------------------------------------------------------------
# Delimited EXEC-block parsing (KIRO-EXEC in the ticket, FINDINGS-EXEC / IMPL-EXEC in hand-offs)
# --------------------------------------------------------------------------------------

def extract_exec_block(text: str, name: str) -> str | None:
    """Return the raw body between `# --- <NAME> ---` and `# --- END <NAME> ---`, or None.

    `name` is e.g. "KIRO-EXEC", "FINDINGS-EXEC", "IMPL-EXEC". Tolerant of surrounding fences.
    """
    start = re.escape(f"# --- {name} ---")
    end = re.escape(f"# --- END {name} ---")
    m = re.search(rf"{start}\s*\n(.*?)\n\s*{end}", text, re.DOTALL)
    return m.group(1) if m else None


def parse_exec_block(text: str, name: str) -> dict[str, Any]:
    """Extract a delimited EXEC block and parse it as YAML (falls back to flat key:value).

    Raises ValueError if the block is missing — callers treat that as "not agent-ready" / STOP.
    """
    body = extract_exec_block(text, name)
    if body is None:
        raise ValueError(f"{name} block not found")
    if yaml is not None:
        data = yaml.safe_load(body)
        if isinstance(data, dict):
            return data
    return _parse_flat_kv(body)


def _parse_flat_kv(body: str) -> dict[str, Any]:
    """Zero-dependency fallback for flat `key: value` scalar blocks."""
    out: dict[str, Any] = {}
    for line in body.splitlines():
        line = line.split("#", 1)[0].strip()  # strip inline comments
        if not line or ":" not in line:
            continue
        key, _, val = line.partition(":")
        out[key.strip()] = _coerce(val.strip())
    return out


def _coerce(v: str) -> Any:
    low = v.lower()
    if low in ("true", "false"):
        return low == "true"
    if low in ("none", "null", ""):
        return None
    if v.isdigit():
        return int(v)
    return v.strip('"').strip("'")


# --------------------------------------------------------------------------------------
# Component -> repo map (the deterministic replacement for fixer Step 2 / analyzer Step 3)
# --------------------------------------------------------------------------------------

@dataclass
class RepoEntry:
    component: str
    type: str                       # "code" | "area"
    repo: str | None = None
    path: str | None = None
    default_base_branch: str | None = None
    default_reviewers: list[str] = field(default_factory=list)


@dataclass
class PackageEntry:
    package: str                    # e.g. "@dfg/entity-library"
    repo: str
    path: str
    registry_id: str | None = None
    base_branch: str = "master"


def _fenced_yaml_blocks(text: str) -> list[Any]:
    """Return every parsed ```yaml ... ``` fenced block in a markdown file."""
    if yaml is None:
        raise RuntimeError("PyYAML required to parse the component map's fenced yaml blocks")
    blocks = re.findall(r"```ya?ml\s*\n(.*?)```", text, re.DOTALL)
    return [yaml.safe_load(b) for b in blocks]


def load_component_map(map_path: str | Path) -> dict[str, RepoEntry]:
    """Parse component-repo-mapping-kiro.md -> {component_name: RepoEntry}.

    Reads the structured `components:` fenced yaml block (the "what Kiro parses" section),
    NOT the human table, so there is a single source of truth.
    """
    text = Path(map_path).read_text()
    entries: dict[str, RepoEntry] = {}
    for block in _fenced_yaml_blocks(text):
        if not isinstance(block, dict) or "components" not in block:
            continue
        for c in block["components"]:
            reviewers = c.get("default_reviewers") or []
            if isinstance(reviewers, str):
                reviewers = [reviewers]
            entries[c["component"]] = RepoEntry(
                component=c["component"],
                type=c["type"],
                repo=c.get("repo"),
                path=c.get("path"),
                default_base_branch=c.get("default_base_branch"),
                default_reviewers=reviewers,
            )
    return entries


def load_packages(map_path: str | Path) -> dict[str, PackageEntry]:
    """Parse the `packages:` fenced yaml block -> {package_name: PackageEntry}."""
    text = Path(map_path).read_text()
    out: dict[str, PackageEntry] = {}
    for block in _fenced_yaml_blocks(text):
        if not isinstance(block, dict) or "packages" not in block:
            continue
        for p in block["packages"]:
            out[p["package"]] = PackageEntry(
                package=p["package"],
                repo=p["repo"],
                path=p["path"],
                registry_id=str(p.get("registry_id")) if p.get("registry_id") else None,
                base_branch=p.get("base_branch", "master"),
            )
    return out


@dataclass
class RepoResolution:
    code_repos: list[RepoEntry]
    ignored_areas: list[str]
    unknown: list[str]              # components / primary_repos not found -> STOP


def resolve_repos(
    components: list[str],
    kiro_exec: dict[str, Any],
    repo_map: dict[str, RepoEntry],
) -> RepoResolution:
    """Deterministic repo selection (fixer Step 2 / analyzer Step 3, resolution rules 1-6).

    - Every Components value is resolved against the map (exact, case-sensitive).
    - type:code -> candidate repo; type:area -> ignored label.
    - If KIRO-EXEC.primary_repos is set it OVERRIDES, but each listed repo must exist in the map.
    - Anything unresolved is returned in .unknown so the caller can STOP + comment (never guess).
    """
    code, areas, unknown = [], [], []

    override = kiro_exec.get("primary_repos") or []
    if override:
        by_repo = {e.repo: e for e in repo_map.values() if e.type == "code"}
        for repo_slug in override:
            if repo_slug in by_repo:
                code.append(by_repo[repo_slug])
            else:
                unknown.append(repo_slug)
    else:
        for comp in components:
            entry = repo_map.get(comp)
            if entry is None:
                unknown.append(comp)
            elif entry.type == "area":
                areas.append(comp)
            elif entry.type == "code":
                code.append(entry)

    # de-dupe by repo slug, preserve order
    seen, deduped = set(), []
    for e in code:
        if e.repo not in seen:
            seen.add(e.repo)
            deduped.append(e)
    return RepoResolution(code_repos=deduped, ignored_areas=areas, unknown=unknown)


def derive_branch_name(issue_key: str, summary: str) -> str:
    """`branch_name: auto` -> <ISSUE-KEY>-<kebab-slug-of-summary> (deterministic; avoids typos)."""
    slug = re.sub(r"[^a-z0-9]+", "-", summary.lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)[:50].strip("-")
    return f"{issue_key}-{slug}" if slug else issue_key


# --------------------------------------------------------------------------------------
# Hand-off gate helpers (the driver branches on these instead of an LLM re-reading prose)
# --------------------------------------------------------------------------------------

def read_findings_gate(findings_path: str | Path) -> dict[str, Any]:
    """Read FINDINGS-EXEC from the analyzer's findings.md. Missing file/block => halt signal."""
    p = Path(findings_path)
    if not p.exists():
        return {"alignment": "absent"}       # analyzer halted / never ran
    try:
        return parse_exec_block(p.read_text(), "FINDINGS-EXEC")
    except ValueError:
        return {"alignment": "absent"}


def read_impl_status(impl_path: str | Path) -> dict[str, Any]:
    """Read IMPL-EXEC from the fixer's implementation.md."""
    p = Path(impl_path)
    if not p.exists():
        return {"status": "absent"}
    try:
        return parse_exec_block(p.read_text(), "IMPL-EXEC")
    except ValueError:
        return {"status": "absent"}


# --------------------------------------------------------------------------------------
# Tiny self-test (run `python3 pipeline_lib.py <path-to-map>` to sanity-check parsing)
# --------------------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    map_file = sys.argv[1] if len(sys.argv) > 1 else \
        str(Path(__file__).resolve().parents[1] / "agents" / "component-repo-mapping-kiro.md")

    repo_map = load_component_map(map_file)
    packages = load_packages(map_file)
    print(f"components parsed: {len(repo_map)}  "
          f"(code={sum(e.type == 'code' for e in repo_map.values())}, "
          f"area={sum(e.type == 'area' for e in repo_map.values())})")
    print(f"packages parsed:   {len(packages)}")

    sample_exec = {"primary_repos": [], "autonomy": "auto-mr", "base_branch": "develop"}
    res = resolve_repos(["VP-VerificationWorkflowEngine", "Core Platform", "Bogus-Component"],
                        sample_exec, repo_map)
    print("resolve code:   ", [e.repo for e in res.code_repos])
    print("resolve areas:  ", res.ignored_areas)
    print("resolve unknown:", res.unknown)
    print("branch name:    ",
          derive_branch_name("DT-46133", "Preserve remark on autoclose"))

    findings = "# --- FINDINGS-EXEC ---\nalignment: aligned\npackage_change: false\n# --- END FINDINGS-EXEC ---"
    print("findings gate:  ", parse_exec_block(findings, "FINDINGS-EXEC"))
