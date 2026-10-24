#!/usr/bin/env python3
"""
pipeline_lib.py — delimited EXEC-block parsing (reused verbatim from the sibling bug-fixer).

Pure functions, no LLM, no network. This is the `# --- NAME-EXEC ---` hand-off convention that
the driver and the LLM node use to exchange control fields without ever escaping code/diffs into
a JSON string (see docs/ARCHITECTURE.md and the sibling's ORCHESTRATION-AUDIT.md §7).

Zero hard dependency: EXEC blocks are flat `key: value` and parse with the regex fallback. PyYAML
is used when present (nested blocks) but not required.
"""

from __future__ import annotations

import re
from typing import Any

try:
    import yaml  # PyYAML (optional)
except ImportError:  # pragma: no cover
    yaml = None


def extract_exec_block(text: str, name: str) -> str | None:
    """Return the raw body between `# --- <NAME> ---` and `# --- END <NAME> ---`, or None.

    `name` is e.g. "REVIEW-INPUT-EXEC", "REVIEW-EXEC". Tolerant of surrounding fences.
    """
    start = re.escape(f"# --- {name} ---")
    end = re.escape(f"# --- END {name} ---")
    m = re.search(rf"{start}\s*\n(.*?)\n\s*{end}", text, re.DOTALL)
    return m.group(1) if m else None


def parse_exec_block(text: str, name: str) -> dict[str, Any]:
    """Extract a delimited EXEC block and parse it (YAML when available, flat key:value otherwise).

    Raises ValueError if the block is missing — callers treat that as a STOP / not-ready signal.
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


if __name__ == "__main__":
    sample = (
        "# --- REVIEW-EXEC ---\n"
        "status: reviewed\n"
        "verdict: needs_changes\n"
        "critical_count: 0\n"
        "high_count: 2\n"
        "# --- END REVIEW-EXEC ---\n"
    )
    print("parse_exec_block:", parse_exec_block(sample, "REVIEW-EXEC"))
    assert parse_exec_block(sample, "REVIEW-EXEC")["high_count"] == 2
    try:
        parse_exec_block("no block here", "REVIEW-EXEC")
        raise SystemExit("expected ValueError")
    except ValueError:
        print("missing-block ValueError: ok")
