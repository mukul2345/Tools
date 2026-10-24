#!/usr/bin/env python3
"""
gitlab_api.py — GitLab REST API v4 client (stdlib urllib, PAT auth).

Why REST in the spine (docs/ARCHITECTURE.md): the spine is a plain Python process and cannot call
MCP tools, so it fetches all MR data deterministically over REST with a PAT — 0 LLM credits. It
also POSTS the review comments the same way (see review_post.py): once review_finalize.py has
written post-plan.json, posting is as deterministic as the fetch and does NOT depend on an MCP
server loading inside the agent session. One auditable write path.

Reads (GET) need only read_api. The write helpers (POST /notes, POST /discussions) need `api`
scope. Every write is a review COMMENT — this module never merges, approves, closes, or edits code.

Auth: reads GITLAB_PERSONAL_ACCESS_TOKEN from the environment (the launcher loads it from the
macOS keychain).
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

DEFAULT_TIMEOUT = 30
MAX_RETRIES = 3


class GitLabError(RuntimeError):
    pass


@dataclass
class GitLabClient:
    host: str                          # e.g. "gitlab.com"
    token: str
    project_id: str                    # URL-encoded path or numeric id

    @classmethod
    def from_env(cls, host: str, project_id: str) -> "GitLabClient":
        token = os.environ.get("GITLAB_PERSONAL_ACCESS_TOKEN", "").strip()
        if not token:
            raise GitLabError(
                "GITLAB_PERSONAL_ACCESS_TOKEN not set (launcher loads it from keychain item "
                "'gitlab-pat'). The spine needs a read_api token to fetch MR data."
            )
        return cls(host=host, token=token, project_id=project_id)

    # ---- low-level ----

    def _base(self) -> str:
        return f"https://{self.host}/api/v4"

    def _get(self, path: str, params: dict[str, Any] | None = None) -> tuple[Any, dict]:
        """GET {base}{path}; returns (parsed_json, response_headers). Retries transient errors."""
        url = self._base() + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"PRIVATE-TOKEN": self.token})
        last_err: Exception | None = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
                    body = resp.read().decode("utf-8")
                    headers = dict(resp.headers.items())
                    return (json.loads(body) if body else None), headers
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES:
                    time.sleep(2 ** attempt)
                    last_err = e
                    continue
                detail = e.read().decode("utf-8", "replace")[:300] if e.fp else ""
                raise GitLabError(f"GitLab {e.code} on {path}: {detail}") from e
            except urllib.error.URLError as e:
                last_err = e
                if attempt < MAX_RETRIES:
                    time.sleep(2 ** attempt)
                    continue
                raise GitLabError(
                    f"GitLab network error on {path}: {e}. Check VPN/proxy and host {self.host}."
                ) from e
        raise GitLabError(f"GitLab request failed after retries: {last_err}")

    def _post(self, path: str, payload: dict[str, Any]) -> Any:
        """POST JSON to {base}{path}; returns parsed JSON.

        Retries ONLY on 429 (rate limit — no side effect) and pre-response network errors. It never
        retries on 5xx, because a note/discussion may have been created server-side before the error
        surfaced and a blind retry would double-post. The caller handles a raised error per item.
        """
        url = self._base() + path
        data = json.dumps(payload).encode("utf-8")
        last_err: Exception | None = None
        for attempt in range(1, MAX_RETRIES + 1):
            req = urllib.request.Request(
                url, data=data, method="POST",
                headers={"PRIVATE-TOKEN": self.token, "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
                    body = resp.read().decode("utf-8")
                    return json.loads(body) if body else None
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")[:400] if e.fp else ""
                if e.code == 429 and attempt < MAX_RETRIES:
                    time.sleep(2 ** attempt)
                    last_err = e
                    continue
                raise GitLabError(f"GitLab {e.code} on POST {path}: {detail}") from e
            except urllib.error.URLError as e:
                # Pre-response failure (DNS/connect/timeout) — safe to retry; nothing was created.
                last_err = e
                if attempt < MAX_RETRIES:
                    time.sleep(2 ** attempt)
                    continue
                raise GitLabError(
                    f"GitLab network error on POST {path}: {e}. Check VPN/proxy and host {self.host}."
                ) from e
        raise GitLabError(f"GitLab POST failed after retries: {last_err}")

    def _get_paginated(self, path: str, params: dict[str, Any] | None = None) -> list[Any]:
        """Follow keyset/offset pagination until exhausted; returns the concatenated list."""
        params = dict(params or {})
        params.setdefault("per_page", 100)
        page = 1
        out: list[Any] = []
        while True:
            params["page"] = page
            data, headers = self._get(path, params)
            if not isinstance(data, list) or not data:
                break
            out.extend(data)
            next_page = headers.get("X-Next-Page") or headers.get("x-next-page")
            if not next_page:
                break
            page = int(next_page)
        return out

    # ---- MR endpoints (all read-only) ----

    def _mr(self, suffix: str = "") -> str:
        return f"/projects/{self.project_id}/merge_requests/{self._iid}{suffix}"

    def get_merge_request(self, iid: int) -> dict:
        self._iid = iid
        data, _ = self._get(self._mr())
        return data

    def list_changed_files(self, iid: int) -> list[dict]:
        """Changed-files inventory: path, new/deleted/renamed flags, and the per-file diff."""
        self._iid = iid
        # /diffs returns one object per file including the 'diff' text; paginated.
        return self._get_paginated(self._mr("/diffs"))

    def list_commits(self, iid: int) -> list[dict]:
        self._iid = iid
        return self._get_paginated(self._mr("/commits"))

    def list_pipelines(self, iid: int) -> list[dict]:
        self._iid = iid
        return self._get_paginated(self._mr("/pipelines"))

    # ---- MR write endpoints (review comments only) ----

    def create_mr_note(self, iid: int, body: str) -> dict:
        """Create an MR-level note (the summary note / consolidated coverage comment)."""
        self._iid = iid
        return self._post(self._mr("/notes"), {"body": body})

    def create_mr_discussion(self, iid: int, body: str, position: dict) -> dict:
        """Create an inline discussion anchored to a diff position.

        `position` must be a GitLab text position: position_type='text', base_sha/head_sha/start_sha
        from the MR diff_refs, and new_path/new_line for an added line. review_finalize.py already
        snapped the finding onto a real added line, so new_path + new_line is sufficient — GitLab
        derives the line_code itself; we never hand-craft one.
        """
        self._iid = iid
        return self._post(self._mr("/discussions"), {"body": body, "position": position})

    def get_file_raw(self, file_path: str, ref: str) -> str:
        """Raw file content at a ref (used only if a non-diff file must be inspected)."""
        enc = urllib.parse.quote(file_path, safe="")
        url = f"{self._base()}/projects/{self.project_id}/repository/files/{enc}/raw"
        url += "?" + urllib.parse.urlencode({"ref": ref})
        req = urllib.request.Request(url, headers={"PRIVATE-TOKEN": self.token})
        try:
            with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
                return resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            raise GitLabError(f"GitLab {e.code} reading {file_path}@{ref}") from e


def build_clone_url(host: str, project_path: str, token: str) -> str:
    """HTTPS clone URL with the PAT embedded (oauth2 user). Never logged by the spine."""
    return f"https://oauth2:{token}@{host}/{project_path}.git"


if __name__ == "__main__":
    # Smoke test only runs when a token + a real MR ref are provided via env, to avoid
    # hitting the network during normal CI. Usage:
    #   GITLAB_PERSONAL_ACCESS_TOKEN=... python3 gitlab_api.py gitlab.com org%2Frepo 123
    import sys

    if len(sys.argv) == 4 and os.environ.get("GITLAB_PERSONAL_ACCESS_TOKEN"):
        host, pid, iid = sys.argv[1], sys.argv[2], int(sys.argv[3])
        c = GitLabClient.from_env(host, pid)
        mr = c.get_merge_request(iid)
        print("title:", mr.get("title"))
        print("source->target:", mr.get("source_branch"), "->", mr.get("target_branch"))
        print("changed files:", len(c.list_changed_files(iid)))
        print("commits:", len(c.list_commits(iid)))
    else:
        print("gitlab_api.py OK (set token + args host project_id iid for a live smoke test)")
