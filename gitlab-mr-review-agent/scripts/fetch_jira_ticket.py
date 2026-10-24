#!/usr/bin/env python3
"""
fetch_jira_ticket.py — download the COMPLETE details of one Jira ticket (0 credits, no LLM).

Reuses context_gather.py's proven Jira Basic-auth REST v3 path (JiraAuth / _get / flatten_adf),
which is independent of the Atlassian Rovo OAuth MCP (that path returns "scope does not match").

It fetches ALL fields for the ticket plus its comments, walks the parent and every subtask, and
writes:
  <out>/<KEY>.json  — raw Jira REST payload (fields=*all, complete fidelity)
  <out>/<KEY>.md    — human/agent-readable summary (ADF flattened), with parent + subtask context

Usage:
  python3 fetch_jira_ticket.py DT-49083 [--out DIR] [--raw]

Env (loaded by the bin/ launcher from keychain):
  ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN, JIRA_BASE_URL
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Reuse the sibling module's tested auth + fetch primitives — no duplication.
from context_gather import JiraAuth, JiraError, _get, flatten_adf


def _adf(node: Any) -> str:
    return flatten_adf(node).strip()


def fetch_full(auth: JiraAuth, key: str) -> dict[str, Any]:
    """Fetch the complete raw issue payload (all fields + comments + changelog)."""
    data = _get(
        auth,
        f"/rest/api/3/issue/{key}",
        {"fields": "*all", "expand": "renderedFields,names,changelog"},
    )
    if not data:
        raise JiraError(f"ticket {key} not found (404) or no access")
    return data


def _brief(auth: JiraAuth, key: str) -> str:
    """One-line summary of a related ticket (parent / subtask), best-effort."""
    d = _get(auth, f"/rest/api/3/issue/{key}", {"fields": "summary,status,issuetype"})
    if not d:
        return f"- {key} (not accessible)"
    f = d.get("fields", {})
    return (
        f"- **{key}** [{(f.get('issuetype') or {}).get('name','?')}] "
        f"({(f.get('status') or {}).get('name','?')}): {f.get('summary','') or ''}".rstrip()
    )


def render_md(auth: JiraAuth, key: str, data: dict[str, Any], base_url: str) -> str:
    f = data.get("fields", {})
    lines: list[str] = []
    lines.append(f"# {key}: {f.get('summary','') or ''}".rstrip())
    lines.append("")
    lines.append(f"- **URL:** {base_url}/browse/{key}")
    lines.append(f"- **Type:** {(f.get('issuetype') or {}).get('name','?')}")
    lines.append(f"- **Status:** {(f.get('status') or {}).get('name','?')}")
    lines.append(f"- **Priority:** {(f.get('priority') or {}).get('name','?')}")
    lines.append(f"- **Assignee:** {(f.get('assignee') or {}).get('displayName','Unassigned')}")
    lines.append(f"- **Reporter:** {(f.get('reporter') or {}).get('displayName','?')}")
    labels = f.get("labels") or []
    if labels:
        lines.append(f"- **Labels:** {', '.join(labels)}")
    comps = [c.get("name", "") for c in (f.get("components") or [])]
    if comps:
        lines.append(f"- **Components:** {', '.join(c for c in comps if c)}")
    fix = [v.get("name", "") for v in (f.get("fixVersions") or [])]
    if fix:
        lines.append(f"- **Fix Versions:** {', '.join(v for v in fix if v)}")
    lines.append(f"- **Created:** {f.get('created','?')}  |  **Updated:** {f.get('updated','?')}")

    parent = f.get("parent") or {}
    if parent.get("key"):
        lines.append("")
        lines.append("## Parent")
        lines.append(_brief(auth, parent["key"]))

    lines.append("")
    lines.append("## Description")
    lines.append(_adf(f.get("description")) or "_(empty)_")

    # Common custom text fields (acceptance criteria) — flatten any ADF-shaped custom field.
    for fid, val in f.items():
        if not fid.startswith("customfield_") or val is None:
            continue
        if isinstance(val, dict) and val.get("type") == "doc":
            text = _adf(val)
            if text:
                pretty = (data.get("names", {}) or {}).get(fid, fid)
                lines.append("")
                lines.append(f"## {pretty}")
                lines.append(text)

    subtasks = f.get("subtasks") or []
    if subtasks:
        lines.append("")
        lines.append("## Subtasks")
        for st in subtasks:
            if st.get("key"):
                lines.append(_brief(auth, st["key"]))

    links = f.get("issuelinks") or []
    if links:
        lines.append("")
        lines.append("## Linked Issues")
        for lk in links:
            rel = lk.get("type", {})
            for direction, label in (("outwardIssue", rel.get("outward", "relates to")),
                                     ("inwardIssue", rel.get("inward", "relates to"))):
                iss = lk.get(direction)
                if iss and iss.get("key"):
                    s = (iss.get("fields", {}) or {}).get("summary", "")
                    lines.append(f"- {label} **{iss['key']}**: {s}")

    comments = ((f.get("comment") or {}).get("comments")) or []
    if comments:
        lines.append("")
        lines.append(f"## Comments ({len(comments)})")
        for c in comments:
            author = (c.get("author") or {}).get("displayName", "?")
            when = c.get("created", "")
            body = _adf(c.get("body"))
            lines.append("")
            lines.append(f"### {author} — {when}")
            lines.append(body or "_(empty)_")

    lines.append("")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Download complete Jira ticket details.")
    ap.add_argument("key", help="Ticket key, e.g. DT-49083")
    ap.add_argument("--out", default=".", help="Output directory (default: cwd)")
    ap.add_argument("--raw", action="store_true", help="Also print raw JSON to stdout")
    args = ap.parse_args(argv)

    try:
        auth = JiraAuth.from_env()
    except JiraError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 3

    try:
        data = fetch_full(auth, args.key)
    except JiraError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 4

    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    json_path = out / f"{args.key}.json"
    md_path = out / f"{args.key}.md"

    json_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    md = render_md(auth, args.key, data, auth.base_url)
    md_path.write_text(md)

    print(f"[ok] wrote {json_path}")
    print(f"[ok] wrote {md_path}")
    print("\n" + "=" * 72 + "\n")
    print(md)
    if args.raw:
        print("\n" + "=" * 72 + " RAW JSON\n")
        print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
