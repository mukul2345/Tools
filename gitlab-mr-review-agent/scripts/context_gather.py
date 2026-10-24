#!/usr/bin/env python3
"""
context_gather.py — deterministic Jira + Confluence + cross-service-MR context ETL (0 credits).

Given the MR's text (title + description + commit messages), this script:
  1. Extracts Jira keys and Confluence URLs (mr_lib regexes, prefix-filtered).
  2. Walks each ticket -> its parent story/bug -> the parent's sibling sub-tasks (Jira REST v3,
     Basic-auth token — NOT MCP, mirroring the sibling's script/agent auth split).
  3. For every visited ticket, finds linked GitLab MRs via the Jira **development panel**
     (dev-status API); falls back to regex over the ticket description + comments when a dev
     didn't formally link the MR.
  4. Flattens ADF rich text to plain text, and writes ONE human+agent readable `jira-context.md`
     plus a `context.json` sidecar the spine can branch on.

The agent later reads `jira-context.md` for business context and is told which sibling-service MRs
it may pull (via GitLab MCP) if the change spans services.

Auth (from env; launcher loads from keychain):
  ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN, JIRA_BASE_URL   (e.g. https://acme.atlassian.net)

Usage:
  python3 context_gather.py --out /tmp/kiro-mr-review/<ws> \
      --seed-file /tmp/.../mr-seed.txt --prefixes DMW,DT,VPT [--mr-host gitlab.com]
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import mr_lib

TIMEOUT = 30
MAX_TICKETS = 25
MAX_DEPTH = 3


class JiraError(RuntimeError):
    pass


@dataclass
class JiraAuth:
    base_url: str
    email: str
    token: str

    @classmethod
    def from_env(cls) -> "JiraAuth":
        base = os.environ.get("JIRA_BASE_URL", "").strip().rstrip("/")
        email = os.environ.get("ATLASSIAN_EMAIL", "").strip()
        token = os.environ.get("ATLASSIAN_API_TOKEN", "").strip()
        missing = [n for n, v in (("JIRA_BASE_URL", base), ("ATLASSIAN_EMAIL", email),
                                  ("ATLASSIAN_API_TOKEN", token)) if not v]
        if missing:
            raise JiraError(f"missing Jira env: {missing} (keychain items jira-base-url / "
                            f"atlassian-email / atlassian-api-token)")
        return cls(base_url=base, email=email, token=token)

    def header(self) -> dict[str, str]:
        raw = f"{self.email}:{self.token}".encode()
        return {"Authorization": "Basic " + base64.b64encode(raw).decode(),
                "Accept": "application/json"}


def _get(auth: JiraAuth, path: str, params: dict | None = None) -> Any:
    url = auth.base_url + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=auth.header())
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise JiraError(f"Jira {e.code} on {path}") from e
    except urllib.error.URLError as e:
        raise JiraError(f"Jira network error on {path}: {e} (check VPN/proxy)") from e


# --------------------------------------------------------------------------------------
# ADF (Atlassian Document Format) -> plain text
# --------------------------------------------------------------------------------------

def flatten_adf(node: Any) -> str:
    """Recursively flatten an ADF rich-text node (or plain string) to text."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(flatten_adf(n) for n in node)
    if not isinstance(node, dict):
        return ""
    t = node.get("type")
    if t == "text":
        return node.get("text", "")
    if t == "hardBreak":
        return "\n"
    if t in ("paragraph", "heading", "blockquote", "listItem", "codeBlock"):
        return flatten_adf(node.get("content")) + "\n"
    if t == "inlineCard":
        return node.get("attrs", {}).get("url", "")
    return flatten_adf(node.get("content"))


# --------------------------------------------------------------------------------------
# Ticket fetch
# --------------------------------------------------------------------------------------

@dataclass
class Ticket:
    key: str
    numeric_id: str = ""
    summary: str = ""
    issuetype: str = ""
    status: str = ""
    parent_key: str = ""
    description: str = ""
    comments: list[str] = field(default_factory=list)
    subtask_keys: list[str] = field(default_factory=list)
    linked_mrs: list[str] = field(default_factory=list)
    confluence_urls: list[str] = field(default_factory=list)


def fetch_ticket(auth: JiraAuth, key: str) -> Ticket | None:
    data = _get(auth, f"/rest/api/3/issue/{key}",
                {"fields": "summary,status,issuetype,parent,description,subtasks,comment,issuelinks"})
    if not data:
        return None
    f = data.get("fields", {})
    t = Ticket(key=key, numeric_id=str(data.get("id", "")))
    t.summary = f.get("summary", "") or ""
    t.issuetype = (f.get("issuetype") or {}).get("name", "") or ""
    t.status = (f.get("status") or {}).get("name", "") or ""
    t.parent_key = (f.get("parent") or {}).get("key", "") or ""
    t.description = flatten_adf(f.get("description")).strip()
    for c in ((f.get("comment") or {}).get("comments") or []):
        t.comments.append(flatten_adf(c.get("body")).strip())
    for st in (f.get("subtasks") or []):
        if st.get("key"):
            t.subtask_keys.append(st["key"])
    # Confluence links + regex-fallback MR links from this ticket's text
    blob = "\n".join([t.description, *t.comments])
    t.confluence_urls = mr_lib.extract_confluence_urls(blob)
    t.linked_mrs = mr_lib.extract_mr_urls(blob)
    return t


def fetch_dev_status_mrs(auth: JiraAuth, numeric_id: str) -> list[str]:
    """Linked MRs from the Jira **development panel** (dev-status API).

    NOTE: dev-status is an internal endpoint; applicationType/dataType casing can vary by
    instance. We try the common variants and merge results; the regex fallback in fetch_ticket
    covers the case where a dev forgot to link the MR at all. Best-effort — never fatal.
    """
    if not numeric_id:
        return []
    found: list[str] = []
    for app in ("GitLab", "gitlab"):
        data = _get(auth, "/rest/dev-status/1.0/issue/detail",
                    {"issueId": numeric_id, "applicationType": app, "dataType": "pullrequest"})
        if not data:
            continue
        for detail in data.get("detail", []):
            for pr in detail.get("pullRequests", []):
                url = pr.get("url")
                if url:
                    found.append(url)
        if found:
            break
    return mr_lib._dedupe(found)


# --------------------------------------------------------------------------------------
# BFS walk: seed keys -> parents -> sibling subtasks (depth/count capped)
# --------------------------------------------------------------------------------------

def gather(auth: JiraAuth, seed_keys: list[str], prefixes: list[str] | None) -> dict[str, Ticket]:
    visited: dict[str, Ticket] = {}
    queue: list[tuple[str, int]] = [(k, 0) for k in seed_keys]
    while queue and len(visited) < MAX_TICKETS:
        key, depth = queue.pop(0)
        if key in visited or depth > MAX_DEPTH:
            continue
        t = fetch_ticket(auth, key)
        if t is None:
            continue
        t.linked_mrs = mr_lib._dedupe(t.linked_mrs + fetch_dev_status_mrs(auth, t.numeric_id))
        visited[key] = t
        # enqueue parent (to reach the story) and siblings (subtasks of the parent)
        if t.parent_key and t.parent_key not in visited:
            queue.append((t.parent_key, depth + 1))
        for st in t.subtask_keys:
            if st not in visited:
                queue.append((st, depth + 1))
        # any Jira keys mentioned in text, prefix-filtered
        for k in mr_lib.extract_jira_keys("\n".join([t.description, *t.comments]), prefixes):
            if k not in visited:
                queue.append((k, depth + 1))
    return visited


# --------------------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------------------

def render_markdown(tickets: dict[str, Ticket], primary_keys: list[str]) -> str:
    lines: list[str] = ["# Jira / Confluence / Cross-service context\n"]
    all_mrs = mr_lib._dedupe([u for t in tickets.values() for u in t.linked_mrs])
    all_conf = mr_lib._dedupe([u for t in tickets.values() for u in t.confluence_urls])

    lines.append("## Related merge requests (other services)")
    lines.append("> The agent MAY pull these via the GitLab MCP if the change spans services.\n")
    if all_mrs:
        for u in all_mrs:
            lines.append(f"- {u}")
    else:
        lines.append("- (none discovered via dev-panel or regex)")
    lines.append("")

    lines.append("## Confluence design docs")
    if all_conf:
        for u in all_conf:
            lines.append(f"- {u}")
    else:
        lines.append("- (none linked)")
    lines.append("")

    for key, t in tickets.items():
        marker = " (primary)" if key in primary_keys else ""
        lines.append(f"## {key} — {t.summary}{marker}")
        lines.append(f"- Type: {t.issuetype} | Status: {t.status}"
                     + (f" | Parent: {t.parent_key}" if t.parent_key else ""))
        if t.subtask_keys:
            lines.append(f"- Sub-tasks: {', '.join(t.subtask_keys)}")
        if t.linked_mrs:
            lines.append(f"- Linked MRs: {', '.join(t.linked_mrs)}")
        lines.append("\n### Description")
        lines.append(t.description or "_(empty)_")
        if t.comments:
            lines.append("\n### Comments")
            for i, c in enumerate(t.comments, 1):
                if c.strip():
                    lines.append(f"{i}. {c}")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="workspace dir to write jira-context.md/json")
    ap.add_argument("--seed-file", help="file containing MR title+description+commits to mine keys from")
    ap.add_argument("--keys", default="", help="comma-separated explicit Jira keys to seed")
    ap.add_argument("--prefixes", default="", help="comma-separated project prefixes to allow")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    prefixes = [p.strip() for p in args.prefixes.split(",") if p.strip()] or None

    seed_text = ""
    if args.seed_file and Path(args.seed_file).exists():
        seed_text = Path(args.seed_file).read_text(errors="replace")
    seed_keys = [k.strip() for k in args.keys.split(",") if k.strip()]
    seed_keys += mr_lib.extract_jira_keys(seed_text, prefixes)
    seed_keys = mr_lib._dedupe(seed_keys)

    if not seed_keys:
        (out / "jira-context.md").write_text(
            "# Jira / Confluence / Cross-service context\n\n"
            "_No Jira ticket key found in the MR title, description, or commits. "
            "Business-logic review will rely on the MR description only._\n")
        (out / "context.json").write_text(json.dumps({"tickets": [], "related_mrs": [],
                                                       "confluence_urls": []}, indent=2))
        print("[context] no Jira keys found; wrote empty context.")
        return 0

    try:
        auth = JiraAuth.from_env()
    except JiraError as e:
        (out / "jira-context.md").write_text(
            f"# Jira context unavailable\n\n_{e}_\n\nSeed keys detected: {seed_keys}\n")
        print(f"[context] {e}")
        return 0  # soft: don't fail the whole review over Jira auth

    tickets = gather(auth, seed_keys, prefixes)
    (out / "jira-context.md").write_text(render_markdown(tickets, seed_keys))
    sidecar = {
        "primary_keys": seed_keys,
        "tickets": [{"key": t.key, "type": t.issuetype, "status": t.status,
                     "parent": t.parent_key, "subtasks": t.subtask_keys,
                     "linked_mrs": t.linked_mrs} for t in tickets.values()],
        "related_mrs": mr_lib._dedupe([u for t in tickets.values() for u in t.linked_mrs]),
        "confluence_urls": mr_lib._dedupe([u for t in tickets.values() for u in t.confluence_urls]),
    }
    (out / "context.json").write_text(json.dumps(sidecar, indent=2))
    print(f"[context] gathered {len(tickets)} ticket(s); "
          f"{len(sidecar['related_mrs'])} related MR(s); "
          f"{len(sidecar['confluence_urls'])} confluence link(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
