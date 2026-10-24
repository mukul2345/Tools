#!/usr/bin/env python3
"""
jira_write.py — WRITE to Jira (comment / transition / create / update / link) with 0 LLM credits.

Reuses context_gather.py's proven Jira Basic-auth REST v3 path (JiraAuth), which is INDEPENDENT
of the Atlassian Rovo OAuth MCP (that path returns "scope does not match" for jira:agent-interface).
context_gather only ships a GET primitive, so this module adds POST/PUT/DELETE and a plain-text ->
ADF (Atlassian Document Format) converter, since REST v3 requires ADF for description / comment
bodies.

Subcommands:
  comment    <KEY>  --body TEXT
  transition <KEY>  --to NAME [--comment TEXT] | --list
  create            --project P --type T --summary S [--parent K] [convenience + --field]
  update     <KEY>  [--summary S] [--description TEXT] [--field ...]
  link              --inward KEY --outward KEY [--type Relates]
  meta              --project P [--type T]      (createmeta: required fields + allowed values)

Field syntax (repeatable --field for anything without a convenience flag, incl. custom fields):
  --field key=value      -> string value           (e.g. --field summary="Fix bug")
  --field key:=json      -> value parsed as JSON    (e.g. --field customfield_10841:='{"id":"10405"}')

Env (loaded by the bin/ launcher from macOS keychain):
  ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN, JIRA_BASE_URL

Examples:
  jira_write.py comment DT-52144 --body "Fix pushed on fix/claim-item-update-document-attributes."
  jira_write.py transition DT-52144 --list
  jira_write.py transition DT-52144 --to "In Progress"
  jira_write.py create --project DT --type Bug --summary "PATCH drops doc attrs" \
      --description "idNumber/dateOfExpiry silently dropped on update." \
      --field customfield_10841:='{"id":"10405"}' --priority "P1 High" --component NE-Narada
  jira_write.py update DT-52144 --field labels:='["MOHESR"]'
  jira_write.py link --inward DT-52144 --outward DT-51406 --type Relates
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# Reuse the tested auth from the sibling module — no credential duplication.
from context_gather import JiraAuth, JiraError, _get  # noqa: F401  (_get used indirectly)

TIMEOUT = 30


# --------------------------------------------------------------------------------------
# Write primitives (context_gather only has _get)
# --------------------------------------------------------------------------------------

def _write(auth: JiraAuth, method: str, path: str, payload: dict | None) -> Any:
    url = auth.base_url + path
    headers = auth.header()
    headers["Content-Type"] = "application/json"
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        # Jira returns {"errorMessages":[...],"errors":{...}} — surface it verbatim, it is gold.
        raise JiraError(f"Jira {e.code} on {method} {path}: {detail}") from e
    except urllib.error.URLError as e:
        raise JiraError(f"Jira network error on {method} {path}: {e} (check VPN/proxy)") from e


def _post(auth: JiraAuth, path: str, payload: dict | None) -> Any:
    return _write(auth, "POST", path, payload)


def _put(auth: JiraAuth, path: str, payload: dict | None) -> Any:
    return _write(auth, "PUT", path, payload)


# --------------------------------------------------------------------------------------
# Plain text -> ADF (REST v3 requires ADF for description / comment bodies)
# --------------------------------------------------------------------------------------

def text_to_adf(text: str) -> dict[str, Any]:
    """Minimal, faithful text -> ADF: blank-line-separated paragraphs, newlines as hardBreaks."""
    paragraphs = text.replace("\r\n", "\n").split("\n\n")
    content: list[dict[str, Any]] = []
    for para in paragraphs:
        para = para.strip("\n")
        if not para.strip():
            continue
        nodes: list[dict[str, Any]] = []
        for i, line in enumerate(para.split("\n")):
            if i:
                nodes.append({"type": "hardBreak"})
            if line:
                nodes.append({"type": "text", "text": line})
        content.append({"type": "paragraph", "content": nodes or [{"type": "text", "text": ""}]})
    if not content:
        content = [{"type": "paragraph", "content": [{"type": "text", "text": ""}]}]
    return {"type": "doc", "version": 1, "content": content}


# --------------------------------------------------------------------------------------
# --field key=value / key:=json parsing
# --------------------------------------------------------------------------------------

def parse_fields(pairs: list[str]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for raw in pairs or []:
        if ":=" in raw:
            key, val = raw.split(":=", 1)
            try:
                fields[key.strip()] = json.loads(val)
            except json.JSONDecodeError as e:
                raise JiraError(f"--field {key.strip()}:= value is not valid JSON: {e}")
        elif "=" in raw:
            key, val = raw.split("=", 1)
            fields[key.strip()] = val
        else:
            raise JiraError(f"--field must be key=value or key:=json, got: {raw!r}")
    return fields


def apply_convenience(fields: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    if getattr(args, "project", None):
        fields["project"] = {"key": args.project}
    if getattr(args, "type", None):
        fields["issuetype"] = {"name": args.type}
    if getattr(args, "summary", None):
        fields["summary"] = args.summary
    if getattr(args, "parent", None):
        fields["parent"] = {"key": args.parent}
    if getattr(args, "priority", None):
        fields["priority"] = {"name": args.priority}
    if getattr(args, "due", None):
        fields["duedate"] = args.due
    if getattr(args, "assignee", None):
        fields["assignee"] = {"accountId": args.assignee}
    if getattr(args, "label", None):
        fields["labels"] = list(args.label)
    if getattr(args, "component", None):
        fields["components"] = [{"name": c} for c in args.component]
    if getattr(args, "fixversion", None):
        fields["fixVersions"] = [{"name": v} for v in args.fixversion]
    if getattr(args, "description", None):
        fields["description"] = text_to_adf(args.description)
    return fields


# --------------------------------------------------------------------------------------
# Subcommands
# --------------------------------------------------------------------------------------

def cmd_comment(auth: JiraAuth, args: argparse.Namespace) -> int:
    res = _post(auth, f"/rest/api/3/issue/{args.key}/comment",
                {"body": text_to_adf(args.body)})
    cid = (res or {}).get("id", "?")
    print(f"[ok] commented on {args.key} (comment id {cid})")
    print(f"     {auth.base_url}/browse/{args.key}")
    return 0


def cmd_transition(auth: JiraAuth, args: argparse.Namespace) -> int:
    data = _get(auth, f"/rest/api/3/issue/{args.key}/transitions") or {}
    trans = data.get("transitions", [])
    if args.list or not args.to:
        print(f"[transitions for {args.key}]")
        for t in trans:
            to = (t.get("to") or {}).get("name", "?")
            print(f"  - {t.get('name')}  (id {t.get('id')})  -> {to}")
        if not args.to:
            return 0
    match = next((t for t in trans if t.get("name", "").lower() == args.to.lower()), None)
    if not match:
        names = ", ".join(t.get("name", "?") for t in trans)
        raise JiraError(f"no transition named {args.to!r} from current status. Available: {names}")
    payload: dict[str, Any] = {"transition": {"id": match["id"]}}
    if args.comment:
        payload["update"] = {"comment": [{"add": {"body": text_to_adf(args.comment)}}]}
    _post(auth, f"/rest/api/3/issue/{args.key}/transitions", payload)
    print(f"[ok] {args.key} transitioned via {match['name']!r} -> "
          f"{(match.get('to') or {}).get('name','?')}")
    return 0


def cmd_create(auth: JiraAuth, args: argparse.Namespace) -> int:
    fields = parse_fields(args.field)
    fields = apply_convenience(fields, args)
    for req in ("project", "issuetype", "summary"):
        if req not in fields:
            raise JiraError(f"create requires {req} (via --project/--type/--summary or --field)")
    res = _post(auth, "/rest/api/3/issue", {"fields": fields}) or {}
    key = res.get("key", "?")
    print(f"[ok] created {key}")
    print(f"     {auth.base_url}/browse/{key}")
    print(json.dumps(res, indent=2))
    return 0


def cmd_update(auth: JiraAuth, args: argparse.Namespace) -> int:
    fields = parse_fields(args.field)
    fields = apply_convenience(fields, args)
    if not fields:
        raise JiraError("update needs at least one field (--summary/--description/--field ...)")
    _put(auth, f"/rest/api/3/issue/{args.key}", {"fields": fields})
    print(f"[ok] updated {args.key}: {', '.join(sorted(fields))}")
    print(f"     {auth.base_url}/browse/{args.key}")
    return 0


def cmd_link(auth: JiraAuth, args: argparse.Namespace) -> int:
    payload = {
        "type": {"name": args.type},
        "inwardIssue": {"key": args.inward},
        "outwardIssue": {"key": args.outward},
    }
    _post(auth, "/rest/api/3/issueLink", payload)
    print(f"[ok] linked {args.inward} <-{args.type}-> {args.outward}")
    return 0


def cmd_meta(auth: JiraAuth, args: argparse.Namespace) -> int:
    params = {"projectKeys": args.project, "expand": "projects.issuetypes.fields"}
    if args.type:
        params["issuetypeNames"] = args.type
    data = _get(auth, "/rest/api/3/issue/createmeta", params) or {}
    projects = data.get("projects", [])
    if not projects:
        raise JiraError(f"no createmeta for project {args.project} (check key / access)")
    for proj in projects:
        for it in proj.get("issuetypes", []):
            print(f"\n== {proj.get('key')} / {it.get('name')} ==")
            for fid, meta in (it.get("fields") or {}).items():
                req = "REQUIRED" if meta.get("required") else "optional"
                name = meta.get("name", fid)
                allowed = meta.get("allowedValues") or []
                extra = ""
                if allowed:
                    vals = [a.get("name") or a.get("value") or a.get("id") for a in allowed[:12]]
                    extra = "  allowed=" + ", ".join(str(v) for v in vals if v is not None)
                flag = "  <<<" if meta.get("required") else ""
                print(f"  [{req:8}] {fid:22} {name}{extra}{flag}")
    return 0


# --------------------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Write to Jira (Rovo-independent, 0 credits).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("comment", help="Add a comment to an issue")
    p.add_argument("key")
    p.add_argument("--body", required=True)
    p.set_defaults(func=cmd_comment)

    p = sub.add_parser("transition", help="Move an issue to a new status (by name)")
    p.add_argument("key")
    p.add_argument("--to", help="Target transition name (e.g. 'In Progress')")
    p.add_argument("--comment", help="Optional comment to add with the transition")
    p.add_argument("--list", action="store_true", help="List available transitions and exit")
    p.set_defaults(func=cmd_transition)

    def add_field_flags(pp: argparse.ArgumentParser) -> None:
        pp.add_argument("--summary")
        pp.add_argument("--description", help="Plain text; converted to ADF")
        pp.add_argument("--priority")
        pp.add_argument("--due", help="duedate, YYYY-MM-DD")
        pp.add_argument("--assignee", help="accountId")
        pp.add_argument("--label", action="append", help="repeatable")
        pp.add_argument("--component", action="append", help="repeatable")
        pp.add_argument("--fixversion", action="append", help="repeatable (by name)")
        pp.add_argument("--field", action="append", default=[],
                        help="key=value or key:=json (repeatable); for custom fields")

    p = sub.add_parser("create", help="Create a new issue / subtask")
    p.add_argument("--project", help="Project key, e.g. DT")
    p.add_argument("--type", help="Issue type name, e.g. Bug / Sub-task / Story")
    p.add_argument("--parent", help="Parent key (for Sub-task)")
    add_field_flags(p)
    p.set_defaults(func=cmd_create)

    p = sub.add_parser("update", help="Edit fields on an existing issue")
    p.add_argument("key")
    add_field_flags(p)
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("link", help="Link two issues")
    p.add_argument("--inward", required=True)
    p.add_argument("--outward", required=True)
    p.add_argument("--type", default="Relates", help="Link type name (default: Relates)")
    p.set_defaults(func=cmd_link)

    p = sub.add_parser("meta", help="Show createmeta (required fields + allowed values)")
    p.add_argument("--project", required=True)
    p.add_argument("--type", help="Restrict to one issue type name")
    p.set_defaults(func=cmd_meta)

    return ap


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    try:
        auth = JiraAuth.from_env()
    except JiraError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 3
    try:
        return args.func(auth, args)
    except JiraError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
