#!/usr/bin/env python3
"""
impact_fallback.py — Tier-1 (approximate) impact map when the ts-morph tracer can't run.

Used only when Node/ts-morph is unavailable. This is a NAME-BASED ripgrep pass: it extracts the
symbol names declared on the changed lines and greps for references across the repo. It is
deliberately labelled APPROXIMATE — it cannot resolve overloads, same-named methods on different
classes, or dynamic dispatch, so it over- and under-reports. It gives the LLM *some* grounding
(direct 1-hop references + filename-based entry hints) rather than nothing.

  python3 impact_fallback.py --clone <dir> --changed-index <json> --out <dir>
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path

DECL_PATTERNS = [
    re.compile(r"\bfunction\s+([a-zA-Z_]\w*)\s*\("),
    re.compile(r"\b(?:public|private|protected|static|async|readonly|\s)*\b([a-zA-Z_]\w*)\s*\([^)]*\)\s*[:{]"),
    re.compile(r"\b([a-zA-Z_]\w*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>"),
]
KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "function", "constructor",
            "await", "typeof", "new", "throw", "else", "do", "case", "super", "this"}


def symbols_on_changed_lines(clone: Path, changed_index: dict) -> dict[str, str]:
    """{symbol_name: 'relpath:line' where declared} for the changed lines."""
    found: dict[str, str] = {}
    for rel, lines in changed_index.items():
        if not rel.endswith(".ts") or rel.endswith(".d.ts"):
            continue
        p = clone / rel
        if not p.exists():
            continue
        content = p.read_text(errors="replace").splitlines()
        want = set(lines)
        for i, line in enumerate(content, 1):
            if i not in want:
                continue
            for rx in DECL_PATTERNS:
                for m in rx.finditer(line):
                    name = m.group(1)
                    if name and name not in KEYWORDS and len(name) > 2:
                        found.setdefault(name, f"{rel}:{i}")
    return found


def rg_references(clone: Path, name: str) -> list[str]:
    """file:line of references to `name` (word-boundary), excluding node_modules/build."""
    if shutil.which("rg"):
        cmd = ["rg", "-n", "--no-heading", "-g", "*.ts", "-g", "!node_modules",
               "-g", "!*.d.ts", "-g", "!dist", rf"\b{re.escape(name)}\b", str(clone)]
    else:
        cmd = ["grep", "-rn", "--include=*.ts", rf"\b{re.escape(name)}\b", str(clone)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    out = []
    for line in r.stdout.splitlines():
        # format: path:line:content
        parts = line.split(":", 2)
        if len(parts) < 2:
            continue
        path = parts[0]
        if "node_modules" in path or path.endswith(".d.ts"):
            continue
        try:
            rel = str(Path(path).resolve().relative_to(clone.resolve()))
        except ValueError:
            rel = path
        out.append(f"{rel}:{parts[1]}")
        if len(out) >= 40:
            break
    return out


def entry_hint(loc: str) -> str:
    if re.search(r"Controller\.ts:", loc):
        return " (likely HTTP controller)"
    if re.search(r"PubSub\.ts:", loc):
        return " (likely SQS PubSub)"
    return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clone", required=True)
    ap.add_argument("--changed-index", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    clone = Path(args.clone).resolve()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    changed_index = json.loads(Path(args.changed_index).read_text())

    symbols = symbols_on_changed_lines(clone, changed_index)
    md = ["# Impact map — APPROXIMATE (ripgrep fallback)\n",
          "> ⚠️ The precise ts-morph tracer could not run, so this is a NAME-BASED grep pass.\n"
          "> It cannot resolve overloads / same-named methods / dynamic dispatch — treat as hints\n"
          "> only, verify manually, and do NOT comment on unchanged code from this alone.\n"]
    sidecar = {"mode": "fallback", "symbols": {}}
    for name, decl_loc in symbols.items():
        refs = [r for r in rg_references(clone, name) if not r.startswith(decl_loc.split(':')[0] + ":" + decl_loc.split(':')[1])]
        entry_refs = [r for r in refs if entry_hint(r)]
        md.append(f"## `{name}` (declared {decl_loc})")
        if entry_refs:
            md.append("**Reference sites at likely entry points:**")
            for r in entry_refs:
                md.append(f"- `{r}`{entry_hint(r)}")
        md.append(f"**All reference sites ({len(refs)}):**")
        for r in refs[:25]:
            md.append(f"- `{r}`{entry_hint(r)}")
        md.append("")
        sidecar["symbols"][name] = {"declared": decl_loc, "references": refs}

    if not symbols:
        md.append("_No function/method declarations detected on the changed lines "
                  "(config/data-only change?)._")

    (out / "impact-map.md").write_text("\n".join(md))
    (out / "impact-map.json").write_text(json.dumps(sidecar, indent=2))
    print(f"[impact-fallback] {len(symbols)} symbol(s) traced (approximate). Wrote impact-map.md/json")
    return 0


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 1:
        # self-test the declaration extractor
        import tempfile
        d = Path(tempfile.mkdtemp())
        (d / "S.ts").write_text(
            "export class S {\n  public closeFollowUp(id: string): void {}\n}\n")
        syms = symbols_on_changed_lines(d, {"S.ts": [2]})
        assert "closeFollowUp" in syms, syms
        print("impact_fallback self-test passed:", syms)
        sys.exit(0)
    sys.exit(main())
