#!/usr/bin/env python3
"""
reference_gather.py — clone/scan READ-ONLY reference sources and distill a grounding context file.

The implement node is told to consult references so it mirrors real patterns/contracts instead of
guessing. To keep that grounding cheap (0 LLM tokens for exploration), this deterministic script:

  1. clones each reference GitLab repo shallow + read-only (into <out>/repos/<name>),
  2. scans the sources (repos + local paths, optionally scoped to `paths`) for the grounding
     `keywords`, extracting the matching regions with surrounding context (size-capped), and
  3. writes a single digest the agent reads first:

     <out>/reference-context.md   grouped, keyword-highlighted excerpts (+ tree fallback)
     <out>/manifest.json          sources, matched files, counts, and any clone errors

If a source has no keywords (neither global nor its own), the script includes the content of its
explicit `paths` (capped) or, for a whole repo with no paths, just a file-tree listing with a note
to add keywords. References are never modified; the clones exist only for the agent to read.

Input spec (JSON, written by the spine from the run config's `references:` block):
  {
    "keywords": ["global", "kw"],
    "repos":  [{"url": "...", "branch": "", "paths": [...], "keywords": [...]}],
    "local":  [{"path": "...", "paths": [...], "keywords": [...]}]
  }

Usage:
  python3 reference_gather.py --spec references-spec.json --out <workspace>/references \
      [--token-env GITLAB_PERSONAL_ACCESS_TOKEN]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import task_pipeline_lib as lib

SKIP_DIRS = {".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt",
             "vendor", "__pycache__", ".venv", "venv", "target", "out", ".idea", ".vscode",
             # test dirs: reference grounding is about production patterns, not test style
             # (test style is governed by the unit-test-guidelines steering file)
             "Tests", "tests", "__tests__", "test", "__mocks__"}
SKIP_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".pdf", ".zip", ".gz", ".tar",
             ".map", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mov", ".class", ".jar",
             ".so", ".dylib", ".bin", ".lock", ".min.js", ".png", ".webp", ".lockb"}
SKIP_NAMES = {"pnpm-lock.yaml", "package-lock.json", "yarn.lock"}
# Test/mock/snapshot files add noise to implementation grounding — excluded by default.
_TEST_FILE_RE = re.compile(r"\.(test|spec|mock)\.[a-z0-9]+$|\.snap$", re.I)

MAX_FILE_BYTES = 400_000        # skip files larger than this (likely generated)
CONTEXT_LINES = 4               # lines of context around each keyword hit
MAX_REGIONS_PER_FILE = 6
MAX_FILES_PER_SOURCE = 40
MAX_TOTAL_BYTES = 300_000       # overall digest budget
MAX_TREE_ENTRIES = 200


def log(msg: str) -> None:
    print(f"[reference_gather] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Pure-ish scanning helpers
# ---------------------------------------------------------------------------

def is_probably_text(path: Path) -> bool:
    try:
        with open(path, "rb") as fh:
            chunk = fh.read(4096)
        return b"\x00" not in chunk
    except OSError:
        return False


def _skip_file(path: Path) -> bool:
    if path.name in SKIP_NAMES:
        return True
    if _TEST_FILE_RE.search(path.name):   # *.test.ts, *.spec.ts, *.test.json, *.mock.ts, *.snap
        return True
    suffixes = "".join(path.suffixes).lower()
    if path.suffix.lower() in SKIP_EXTS or any(suffixes.endswith(e) for e in SKIP_EXTS):
        return True
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return True
    except OSError:
        return True
    return False


def iter_files(root: Path):
    """Yield candidate text files under `root`, skipping vendor/binary/oversized files."""
    if root.is_file():
        if not _skip_file(root) and is_probably_text(root):
            yield root
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            p = Path(dirpath) / name
            if not _skip_file(p) and is_probably_text(p):
                yield p


def keyword_regions(lines: list[str], keywords: list[str],
                    context: int = CONTEXT_LINES,
                    max_regions: int = MAX_REGIONS_PER_FILE) -> list[tuple[int, int, set[int]]]:
    """Return merged (start, end, hit_line_indices) regions where any keyword appears (ci)."""
    kws = [k.lower() for k in keywords if k]
    if not kws:
        return []
    hits = [i for i, line in enumerate(lines) if any(k in line.lower() for k in kws)]
    regions: list[list] = []
    for i in hits:
        s, e = max(0, i - context), min(len(lines), i + context + 1)
        if regions and s <= regions[-1][1]:
            regions[-1][1] = max(regions[-1][1], e)
            regions[-1][2].add(i)
        else:
            regions.append([s, e, {i}])
    return [(s, e, h) for s, e, h in regions[:max_regions]]


def _lang_hint(path: Path) -> str:
    return {".ts": "ts", ".tsx": "tsx", ".js": "js", ".py": "python", ".java": "java",
            ".go": "go", ".json": "json", ".yml": "yaml", ".yaml": "yaml",
            ".md": "markdown", ".sh": "bash"}.get(path.suffix.lower(), "")


# ---------------------------------------------------------------------------
# git clone (read-only, shallow)
# ---------------------------------------------------------------------------

def clone_reference_repo(url: str, branch: str, dest: Path, token: str) -> str | None:
    """Shallow-clone a reference repo. Returns an error string on failure, else None."""
    if dest.exists():
        subprocess.run(["rm", "-rf", str(dest)], check=False)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        curl = lib.token_clone_url(url, token)
    except ValueError as e:
        return str(e)
    cmd = ["git", "clone", "--depth", "1", "--single-branch"]
    if branch:
        cmd += ["--branch", branch]
    cmd += [curl, str(dest)]
    shown = " ".join(cmd).replace(token, "***") if token else " ".join(cmd)
    log("$ " + shown)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return (r.stderr or r.stdout).replace(token, "***").strip()[:400] if token \
            else (r.stderr or r.stdout).strip()[:400]
    return None


# ---------------------------------------------------------------------------
# Digest rendering
# ---------------------------------------------------------------------------

class Budget:
    def __init__(self, total: int):
        self.remaining = total
        self.truncated = False

    def take(self, text: str) -> bool:
        n = len(text.encode("utf-8", "ignore"))
        if n > self.remaining:
            self.truncated = True
            return False
        self.remaining -= n
        return True


def render_source(out_lines: list[str], manifest_src: dict, *, title: str, root: Path,
                  search_roots: list[Path], keywords: list[str], budget: Budget) -> None:
    out_lines.append(f"## {title}")
    if keywords:
        out_lines.append(f"_grounding keywords: {', '.join('`'+k+'`' for k in keywords)}_")
    out_lines.append("")

    files_scanned = 0
    files_matched = 0
    matched_paths: list[str] = []
    seen: set[str] = set()   # dedup files reached via overlapping search roots (e.g. dir + file)

    if keywords:
        for sroot in search_roots:
            for path in iter_files(sroot):
                if files_matched >= MAX_FILES_PER_SOURCE:
                    out_lines.append(f"_… reached {MAX_FILES_PER_SOURCE}-file cap for this source._")
                    out_lines.append("")
                    break
                rkey = str(path.resolve())
                if rkey in seen:
                    continue
                seen.add(rkey)
                files_scanned += 1
                try:
                    text = path.read_text(errors="replace")
                except OSError:
                    continue
                lines = text.splitlines()
                regions = keyword_regions(lines, keywords)
                if not regions:
                    continue
                rel = _rel(path, root)
                block = _render_file_block(path, rel, lines, regions)
                if not budget.take(block):
                    out_lines.append("_… reference digest size budget reached; "
                                     "remaining matches omitted (open the clones for more)._")
                    out_lines.append("")
                    manifest_src["files_scanned"] = files_scanned
                    manifest_src["files_matched"] = files_matched
                    manifest_src["matched_paths"] = matched_paths
                    return
                out_lines.append(block)
                files_matched += 1
                matched_paths.append(rel)
        if files_matched == 0:
            out_lines.append(f"_No matches for the keywords in {files_scanned} scanned file(s)._")
            out_lines.append("")
    else:
        # No keywords: include explicit paths' content, else just a tree listing.
        explicit = any(sr != root for sr in search_roots)
        if explicit:
            for sroot in search_roots:
                for path in iter_files(sroot):
                    if files_matched >= MAX_FILES_PER_SOURCE:
                        break
                    rkey = str(path.resolve())
                    if rkey in seen:
                        continue
                    seen.add(rkey)
                    try:
                        lines = path.read_text(errors="replace").splitlines()
                    except OSError:
                        continue
                    rel = _rel(path, root)
                    block = _render_file_block(path, rel, lines,
                                               [(0, min(len(lines), 200), set())])
                    if not budget.take(block):
                        budget.truncated = True
                        break
                    out_lines.append(block)
                    files_matched += 1
                    matched_paths.append(rel)
        else:
            out_lines.append("_No keywords or paths given for this source — listing the file tree "
                             "only. Add `keywords` (or `paths`) to include grounded excerpts._")
            out_lines.append("")
            tree = _render_tree(root)
            budget.take(tree)
            out_lines.append(tree)
            out_lines.append("")

    manifest_src["files_scanned"] = files_scanned
    manifest_src["files_matched"] = files_matched
    manifest_src["matched_paths"] = matched_paths


def _rel(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def _render_file_block(path: Path, rel: str, lines: list[str],
                       regions: list[tuple[int, int, set[int]]]) -> str:
    lang = _lang_hint(path)
    out = [f"### `{rel}`", ""]
    for (s, e, hits) in regions:
        out.append(f"```{lang}")
        for idx in range(s, e):
            marker = "»" if idx in hits else " "
            out.append(f"{idx + 1:>5} {marker} {lines[idx]}")
        out.append("```")
    out.append("")
    return "\n".join(out)


def _render_tree(root: Path) -> str:
    entries = []
    for path in iter_files(root):
        entries.append(_rel(path, root))
        if len(entries) >= MAX_TREE_ENTRIES:
            entries.append(f"… (truncated at {MAX_TREE_ENTRIES} entries)")
            break
    return "```\n" + "\n".join(entries) + "\n```"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Distill read-only reference context for grounding.")
    ap.add_argument("--spec", required=True, help="references-spec.json path")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--token-env", default="GITLAB_PERSONAL_ACCESS_TOKEN",
                    help="env var holding the GitLab PAT for cloning reference repos")
    args = ap.parse_args()

    spec = json.loads(Path(args.spec).read_text())
    global_keywords = [str(k) for k in (spec.get("keywords") or [])]
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    token = os.environ.get(args.token_env, "")

    out_lines = ["# Reference context", ""]
    if global_keywords:
        out_lines.append(f"Global grounding keywords: "
                         f"{', '.join('`'+k+'`' for k in global_keywords)}")
        out_lines.append("")
    out_lines.append("These are READ-ONLY references for grounding the implementation. Never edit "
                     "them. Full clones are under `references/repos/` if you need more than the "
                     "excerpts below.")
    out_lines.append("")

    budget = Budget(MAX_TOTAL_BYTES)
    manifest = {"keywords": global_keywords, "sources": [], "errors": []}

    # Reference repos (clone read-only, then scan)
    for r in spec.get("repos") or []:
        url = r["url"]
        name = lib.repo_name_from_url(url)
        dest = out_dir / "repos" / name
        src = {"kind": "repo", "url": url, "name": name, "branch": r.get("branch", "")}
        err = clone_reference_repo(url, r.get("branch", ""), dest, token)
        if err:
            log(f"clone failed for {url}: {err}")
            manifest["errors"].append({"url": url, "error": err})
            src["clone_error"] = err
            manifest["sources"].append(src)
            out_lines.append(f"## repo: {name}")
            out_lines.append(f"_clone failed: {err}_")
            out_lines.append("")
            continue
        kws = _merge(r.get("keywords"), global_keywords)
        paths = r.get("paths") or []
        search_roots = [dest / p for p in paths] if paths else [dest]
        search_roots = [s for s in search_roots if s.exists()] or [dest]
        render_source(out_lines, src, title=f"repo: {name}"
                      + (f" (branch {r['branch']})" if r.get("branch") else ""),
                      root=dest, search_roots=search_roots, keywords=kws, budget=budget)
        manifest["sources"].append(src)

    # Local references
    for l in spec.get("local") or []:
        base = Path(str(l["path"])).expanduser()
        src = {"kind": "local", "path": str(base)}
        if not base.exists():
            log(f"local reference not found: {base}")
            manifest["errors"].append({"path": str(base), "error": "not found"})
            src["error"] = "not found"
            manifest["sources"].append(src)
            out_lines.append(f"## local: {base}")
            out_lines.append("_path not found._")
            out_lines.append("")
            continue
        kws = _merge(l.get("keywords"), global_keywords)
        paths = l.get("paths") or []
        root = base if base.is_dir() else base.parent
        search_roots = [base / p for p in paths] if (paths and base.is_dir()) else [base]
        search_roots = [s for s in search_roots if s.exists()] or [base]
        render_source(out_lines, src, title=f"local: {base}",
                      root=root, search_roots=search_roots, keywords=kws, budget=budget)
        manifest["sources"].append(src)

    if budget.truncated:
        manifest["truncated"] = True

    (out_dir / "reference-context.md").write_text("\n".join(out_lines) + "\n")
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    n_src = len(manifest["sources"])
    n_err = len(manifest["errors"])
    n_matched = sum(s.get("files_matched", 0) for s in manifest["sources"])
    log(f"wrote reference-context.md — {n_src} source(s), {n_matched} matched file(s), "
        f"{n_err} error(s)" + (" [size-truncated]" if budget.truncated else ""))
    return 0


def _merge(source_keywords, global_keywords) -> list[str]:
    out, seen = [], set()
    for k in list(source_keywords or []) + list(global_keywords or []):
        k = str(k).strip()
        if k and k.lower() not in seen:
            seen.add(k.lower())
            out.append(k)
    return out


if __name__ == "__main__":
    sys.exit(main())
