#!/usr/bin/env python3
"""
jira_client.py — minimal, read-only Jira Cloud REST client for the deterministic preflight.

Why a script (not the MCP): the spine needs to (1) confirm the Jira subtask id actually resolves
— a hard gate — and (2) read its summary to derive the branch name and MR title, all at 0 credits
before any LLM spins up. This mirrors the bug-fixer's split: scripts talk to Jira over the REST
API with a Basic-auth API token; the agent does all Jira *writes* (the final comment) over the
Rovo MCP. One auditable write path.

Auth (from the environment / keychain, never inline):
    ATLASSIAN_EMAIL       your Atlassian account email
    ATLASSIAN_API_TOKEN   an API token from id.atlassian.com -> Security -> API tokens
    JIRA_BASE_URL         https://<site>.atlassian.net

Stdlib only (urllib/json/base64) — no venv needed.

CLI (manual check):
    python3 jira_client.py DT-46443
"""

from __future__ import annotations

import base64
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Optional


class JiraError(RuntimeError):
    """Base class for Jira preflight failures (the spine turns these into a clear STOP)."""


class JiraAuthError(JiraError):
    pass


class JiraNotFound(JiraError):
    pass


@dataclass
class JiraIssue:
    key: str
    summary: str
    issue_type: str
    status: str
    project_key: str
    parent_key: Optional[str] = None

    @property
    def is_subtask(self) -> bool:
        return self.parent_key is not None

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "summary": self.summary,
            "issue_type": self.issue_type,
            "status": self.status,
            "project_key": self.project_key,
            "parent_key": self.parent_key,
            "is_subtask": self.is_subtask,
        }


def _require_env() -> tuple[str, str, str]:
    email = os.environ.get("ATLASSIAN_EMAIL", "").strip()
    token = os.environ.get("ATLASSIAN_API_TOKEN", "").strip()
    base = os.environ.get("JIRA_BASE_URL", "").strip().rstrip("/")
    missing = [name for name, val in
               (("ATLASSIAN_EMAIL", email), ("ATLASSIAN_API_TOKEN", token),
                ("JIRA_BASE_URL", base)) if not val]
    if missing:
        raise JiraAuthError(
            "missing Jira credentials in the environment: " + ", ".join(missing) +
            " (store them in the keychain and let the launcher export them)")
    return email, token, base


def _auth_header(email: str, token: str) -> str:
    raw = f"{email}:{token}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _get(url: str, auth: str, timeout: int = 20) -> Any:
    req = urllib.request.Request(url, headers={
        "Authorization": auth,
        "Accept": "application/json",
        "User-Agent": "jira-gitlab-task-implementer/1.0",
    })
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise JiraAuthError(f"Jira auth failed (HTTP {e.code}) — check ATLASSIAN_EMAIL / "
                                f"ATLASSIAN_API_TOKEN and their scopes") from e
        if e.code == 404:
            raise JiraNotFound(f"Jira issue not found (HTTP 404) at {url}") from e
        raise JiraError(f"Jira request failed (HTTP {e.code}) for {url}") from e
    except urllib.error.URLError as e:
        raise JiraError(f"could not reach Jira at {url}: {e.reason} "
                        f"(VPN/proxy? check JIRA_BASE_URL)") from e


def get_issue(key: str) -> JiraIssue:
    """Fetch a single issue's summary/type/status/parent. Raises JiraNotFound if it doesn't exist."""
    email, token, base = _require_env()
    auth = _auth_header(email, token)
    fields = "summary,issuetype,status,parent,project"
    url = f"{base}/rest/api/3/issue/{key}?fields={fields}"
    data = _get(url, auth)
    f = data.get("fields", {}) or {}
    parent = f.get("parent") or {}
    project = f.get("project") or {}
    return JiraIssue(
        key=data.get("key", key),
        summary=str(f.get("summary", "")).strip(),
        issue_type=str((f.get("issuetype") or {}).get("name", "")).strip(),
        status=str((f.get("status") or {}).get("name", "")).strip(),
        project_key=str(project.get("key", "")).strip(),
        parent_key=(str(parent.get("key")).strip() if parent.get("key") else None),
    )


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python3 jira_client.py <ISSUE-KEY>", file=sys.stderr)
        return 2
    try:
        issue = get_issue(sys.argv[1])
    except JiraError as e:
        print(f"[jira] ERROR: {e}", file=sys.stderr)
        return 1
    print(json.dumps(issue.as_dict(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
