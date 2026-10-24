#!/usr/bin/env python3
"""
jira_gather.py — deterministic Jira ticket-history ETL for the bug-fixer analyzer.

Given a code-fix issue key, it walks the linked-issue graph (issue links + remote links +
ticket keys mentioned in text), pulls every issue's description and all comments, flattens
Atlassian Document Format (ADF) to text, sorts everything into one chronological timeline,
detects references to code repositories, and writes:

  <out>/ticket-history.md    human/agent-readable chronological timeline
  <out>/ticket-history.json  structured sidecar {tickets:[...], repos:[...], timeline:[...]}

No third-party dependencies (stdlib only) — safe to run on macOS/Apple-silicon with the system
Python, no venv needed.

Auth: Jira Cloud REST API v3 with an API token via Basic auth (Atlassian's recommended method
for scripts). Reads from the environment:
  ATLASSIAN_EMAIL       your Atlassian account email
  ATLASSIAN_API_TOKEN   an API token (id.atlassian.com -> API tokens)
  JIRA_BASE_URL         e.g. https://your-site.atlassian.net

Usage:
  python3 jira_gather.py DT-46133 --out /tmp/kiro-bugfix/DT-46133 \
      [--max-depth 4] [--max-tickets 60] [--project-prefixes DT,VP] [--mapping /path/map.md]
"""

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# Tunable at runtime via CLI flags (see main()).
HTTP_TIMEOUT = 30      # seconds per request
HTTP_RETRIES = 3       # attempts on timeout / transient network error

TICKET_KEY_RE = re.compile(r"\b([A-Z][A-Z0-9]+-\d+)\b")
GITLAB_URL_RE = re.compile(r"(?:https?://[^\s)]*?gitlab[^\s)/]*/|git@[^\s:]*?gitlab[^\s:]*:)([A-Za-z0-9._\-/]+?)(?:\.git)?(?=[\s)\]]|$)")


def _fail(msg, code=2):
    print(f"[jira_gather] ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def _auth_header():
    email = os.environ.get("ATLASSIAN_EMAIL")
    token = os.environ.get("ATLASSIAN_API_TOKEN")
    if not email or not token:
        _fail("ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN must be set in the environment.")
    raw = f"{email}:{token}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _base_url():
    base = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
    if not base:
        _fail("JIRA_BASE_URL must be set (e.g. https://your-site.atlassian.net).")
    return base


def _network_hint():
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "(none set)"
    return (f"Could not reach Jira at {_base_url()}.\n"
            f"  - Are you on the VPN / corporate network required to reach Jira?\n"
            f"  - HTTPS_PROXY = {proxy}. If Jira needs a proxy, export HTTPS_PROXY before running.\n"
            f"  - Verify JIRA_BASE_URL is correct: it should be like https://<site>.atlassian.net\n"
            f"  - Quick test: curl -m 20 -u \"$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN\" "
            f"{_base_url()}/rest/api/3/myself")


def _get(path, params=None):
    """GET against the Jira REST API; returns parsed JSON (or None on 404).

    Retries on timeouts / transient network errors with linear backoff. urllib's default
    opener already honors HTTP(S)_PROXY / NO_PROXY environment variables.
    """
    url = _base_url() + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": _auth_header(),
        "Accept": "application/json",
    })
    last_err = None
    for attempt in range(1, HTTP_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # HTTP-level responses are not retried — they are deterministic.
            if e.code in (401, 403):
                _fail(f"Auth/permission error ({e.code}) calling {path}. "
                      f"Check ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN and your Jira permissions.")
            if e.code == 404:
                return None
            if e.code == 429:  # rate limited — honor Retry-After and retry
                wait = int(e.headers.get("Retry-After", "5"))
                print(f"[jira_gather] 429 rate-limited, waiting {wait}s", file=sys.stderr)
                time.sleep(wait)
                last_err = e
                continue
            _fail(f"HTTP {e.code} calling {path}: {e.read().decode('utf-8', 'ignore')[:300]}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = e
            reason = getattr(e, "reason", e)
            print(f"[jira_gather] attempt {attempt}/{HTTP_RETRIES} failed for {path}: {reason}",
                  file=sys.stderr)
            if attempt < HTTP_RETRIES:
                time.sleep(2 * attempt)  # 2s, 4s, ...
    _fail(f"Network error after {HTTP_RETRIES} attempts calling {path}: {last_err}\n\n"
          f"{_network_hint()}")


# ---------------------------------------------------------------------------
# ADF (Atlassian Document Format) -> plain text
# ---------------------------------------------------------------------------
def adf_to_text(node):
    """Recursively flatten an ADF document/node into readable plain text."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(adf_to_text(n) for n in node)

    ntype = node.get("type")
    out = []

    if ntype == "text":
        out.append(node.get("text", ""))
    elif ntype in ("hardBreak",):
        out.append("\n")
    elif ntype == "mention":
        out.append("@" + node.get("attrs", {}).get("text", "user"))
    elif ntype == "inlineCard":
        out.append(node.get("attrs", {}).get("url", ""))
    elif ntype == "codeBlock":
        out.append("\n```\n" + adf_to_text(node.get("content")) + "\n```\n")

    # Recurse into children for block/container nodes.
    if ntype not in ("text", "codeBlock") and node.get("content") is not None:
        out.append(adf_to_text(node.get("content")))

    # Add block separators for readability.
    if ntype in ("paragraph", "heading", "listItem", "blockquote", "bulletList",
                 "orderedList", "tableRow"):
        out.append("\n")
    return "".join(out)


def _clean(text):
    text = re.sub(r"\n{3,}", "\n\n", text or "")
    return text.strip()


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------
def fetch_issue(key):
    fields = "summary,status,issuetype,priority,created,updated,description,issuelinks,components,reporter,assignee"
    return _get(f"/rest/api/3/issue/{key}", {"fields": fields})


def fetch_all_comments(key):
    comments, start, page = [], 0, 100
    while True:
        data = _get(f"/rest/api/3/issue/{key}/comment",
                    {"startAt": start, "maxResults": page, "orderBy": "created"})
        if not data:
            break
        batch = data.get("comments", [])
        comments.extend(batch)
        total = data.get("total", 0)
        start += len(batch)
        if not batch or start >= total:
            break
    return comments


def fetch_remote_links(key):
    data = _get(f"/rest/api/3/issue/{key}/remotelink")
    return data or []


def _linked_keys(issue):
    keys = set()
    for link in issue.get("fields", {}).get("issuelinks", []) or []:
        for side in ("inwardIssue", "outwardIssue"):
            if side in link and link[side].get("key"):
                keys.add(link[side]["key"])
    return keys


def _detect_repos(text, acc):
    for m in GITLAB_URL_RE.finditer(text or ""):
        acc.add(m.group(1).strip("/"))


def _valid_key(candidate, prefixes):
    if prefixes and candidate.split("-")[0] not in prefixes:
        return False
    return True


# ---------------------------------------------------------------------------
# Traversal
# ---------------------------------------------------------------------------
def gather(root_key, max_depth, max_tickets, prefixes):
    visited = {}
    repos = set()
    order = [(root_key, 0)]
    seen = {root_key}

    while order and len(visited) < max_tickets:
        key, depth = order.pop(0)
        issue = fetch_issue(key)
        if not issue:
            print(f"[jira_gather] skip {key} (not found / no access)", file=sys.stderr)
            continue

        f = issue.get("fields", {})
        desc_text = _clean(adf_to_text(f.get("description")))
        comments = fetch_all_comments(key)
        remote = fetch_remote_links(key)

        record = {
            "key": key,
            "summary": f.get("summary", ""),
            "type": (f.get("issuetype") or {}).get("name", ""),
            "status": (f.get("status") or {}).get("name", ""),
            "priority": (f.get("priority") or {}).get("name", ""),
            "created": f.get("created"),
            "updated": f.get("updated"),
            "reporter": (f.get("reporter") or {}).get("displayName", ""),
            "components": [c.get("name") for c in (f.get("components") or [])],
            "depth": depth,
            "description": desc_text,
            "comments": [],
        }

        _detect_repos(desc_text, repos)
        for c in remote:
            url = (c.get("object") or {}).get("url", "")
            _detect_repos(url, repos)

        for c in comments:
            body = _clean(adf_to_text(c.get("body")))
            record["comments"].append({
                "author": (c.get("author") or {}).get("displayName", ""),
                "created": c.get("created"),
                "body": body,
            })
            _detect_repos(body, repos)

        visited[key] = record

        if depth < max_depth:
            # Follow formal issue links.
            candidates = set(_linked_keys(issue))
            # Follow ticket keys mentioned in description + comments.
            blob = desc_text + "\n" + "\n".join(cc["body"] for cc in record["comments"])
            for m in TICKET_KEY_RE.finditer(blob):
                candidates.add(m.group(1))
            for cand in candidates:
                if cand not in seen and _valid_key(cand, prefixes):
                    seen.add(cand)
                    order.append((cand, depth + 1))

    return visited, sorted(repos)


# ---------------------------------------------------------------------------
# Timeline + output
# ---------------------------------------------------------------------------
def _parse_ts(ts):
    if not ts:
        return datetime.max.replace(tzinfo=timezone.utc)
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return datetime.max.replace(tzinfo=timezone.utc)


def build_timeline(visited):
    events = []
    for key, rec in visited.items():
        if rec["description"]:
            events.append({
                "ts": rec["created"], "ticket": key, "author": rec["reporter"],
                "kind": "description", "summary": rec["summary"], "text": rec["description"],
            })
        for c in rec["comments"]:
            events.append({
                "ts": c["created"], "ticket": key, "author": c["author"],
                "kind": "comment", "summary": rec["summary"], "text": c["body"],
            })
    events.sort(key=lambda e: _parse_ts(e["ts"]))
    return events


def write_outputs(out_dir, root_key, visited, repos, timeline):
    os.makedirs(out_dir, exist_ok=True)

    root = visited.get(root_key, {})
    sidecar = {
        "root": root_key,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        # Root-ticket native fields hoisted to the top level so the deterministic spine
        # (run_pipeline.py step_resolve) can branch on them without re-parsing prose or
        # re-calling Jira. `components` drives repo resolution; `root_summary` feeds
        # deterministic branch-name derivation.
        "components": root.get("components", []),
        "root_summary": root.get("summary", ""),
        "tickets": [
            {k: rec[k] for k in ("key", "summary", "type", "status", "priority",
                                 "created", "updated", "depth", "components")}
            for rec in visited.values()
        ],
        "repos_referenced": repos,
        "timeline": timeline,
    }
    with open(os.path.join(out_dir, "ticket-history.json"), "w") as fh:
        json.dump(sidecar, fh, indent=2)

    # ticket.md — the root ticket's description verbatim, the single source the spine parses the
    # KIRO-EXEC block from. Kept separate from ticket-history.md (the multi-ticket timeline) so
    # the delimited block is easy to locate and isn't diluted by linked-ticket text.
    with open(os.path.join(out_dir, "ticket.md"), "w") as fh:
        fh.write(f"# {root_key} — {root.get('summary', '')}\n\n")
        fh.write(root.get("description", "") or "(no description)")
        fh.write("\n")

    lines = [f"# Ticket history for {root_key}", ""]
    lines.append(f"Generated {sidecar['generated_at']}. "
                 f"{len(visited)} ticket(s), {len(timeline)} event(s).")
    lines.append("")
    lines.append("## Tickets discovered")
    lines.append("")
    lines.append("| Key | Type | Status | Depth | Summary |")
    lines.append("| --- | --- | --- | --- | --- |")
    for rec in sorted(visited.values(), key=lambda r: r["depth"]):
        s = (rec["summary"] or "").replace("|", "\\|")
        lines.append(f"| {rec['key']} | {rec['type']} | {rec['status']} | {rec['depth']} | {s} |")
    lines.append("")
    if repos:
        lines.append("## Repositories referenced")
        lines.append("")
        for r in repos:
            lines.append(f"- `{r}`")
        lines.append("")
    lines.append("## Chronological timeline")
    lines.append("")
    for e in timeline:
        ts = e["ts"] or "(no timestamp)"
        header = f"### {ts} — {e['ticket']} — {e['kind']} — {e['author'] or 'unknown'}"
        lines.append(header)
        lines.append("")
        lines.append(e["text"] or "(empty)")
        lines.append("")
    with open(os.path.join(out_dir, "ticket-history.md"), "w") as fh:
        fh.write("\n".join(lines))


def _load_prefixes(args):
    if args.project_prefixes:
        return {p.strip().upper() for p in args.project_prefixes.split(",") if p.strip()}
    return None


def main():
    ap = argparse.ArgumentParser(description="Gather Jira ticket history for the analyzer.")
    ap.add_argument("issue_key")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--max-depth", type=int, default=4)
    ap.add_argument("--max-tickets", type=int, default=60)
    ap.add_argument("--project-prefixes", default="",
                    help="comma-separated allowed project prefixes to follow (e.g. DT,VP)")
    ap.add_argument("--timeout", type=int, default=30, help="per-request timeout in seconds")
    ap.add_argument("--retries", type=int, default=3, help="attempts on timeout/transient error")
    args = ap.parse_args()

    global HTTP_TIMEOUT, HTTP_RETRIES
    HTTP_TIMEOUT, HTTP_RETRIES = args.timeout, args.retries

    # Preflight: fast, lightweight auth+connectivity check with a clear message on failure.
    me = _get("/rest/api/3/myself")
    if me is None:
        _fail("Preflight /myself returned 404 — is JIRA_BASE_URL a Jira Cloud site "
              "(https://<site>.atlassian.net)?")
    print(f"[jira_gather] connected as {me.get('displayName') or me.get('emailAddress','?')}")

    prefixes = _load_prefixes(args)
    visited, repos = gather(args.issue_key, args.max_depth, args.max_tickets, prefixes)
    if args.issue_key not in visited:
        _fail(f"Root issue {args.issue_key} could not be fetched.")
    timeline = build_timeline(visited)
    write_outputs(args.out, args.issue_key, visited, repos, timeline)
    print(f"[jira_gather] wrote {os.path.join(args.out, 'ticket-history.md')} "
          f"({len(visited)} tickets, {len(timeline)} events, {len(repos)} repos)")


if __name__ == "__main__":
    main()
