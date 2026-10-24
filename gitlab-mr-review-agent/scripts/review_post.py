#!/usr/bin/env python3
"""
review_post.py — deterministic poster for MR review comments.

This is the write half of the spine's "one auditable path". Once review_finalize.py has written
post-plan.json, posting is as mechanical as the fetch: read the plan and POST everything over
REST+PAT (gitlab_api.py) — inline comments, the summary note, and the coverage comment if any. No
menu: the team asked for "always post everything". No MCP server, no LLM, no credits.

Re-running is a no-op unless --force (a posted.json marker records what went out). Use --dry-run
to preview without posting.

Usage:
    python3 review_post.py --ws <workspace>             # post everything
    python3 review_post.py --ws <workspace> --dry-run   # show, post nothing
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys
from pathlib import Path

import gitlab_api
import mr_lib

def _load_plan(ws: Path) -> dict:
    p = ws / "post-plan.json"
    if not p.exists():
        sys.exit(f"STOP: {p} not found. Run review_finalize.py first (the agent writes review.md, "
                 f"then finalize produces post-plan.json).")
    return json.loads(p.read_text())


def _load_ref_and_refs(ws: Path) -> tuple[mr_lib.MRRef, dict]:
    mr_json = ws / "mr.json"
    if not mr_json.exists():
        sys.exit(f"STOP: {mr_json} not found — cannot resolve the MR to post to.")
    mr = json.loads(mr_json.read_text())
    web_url = mr.get("web_url")
    if not web_url:
        sys.exit("STOP: mr.json has no web_url — cannot resolve host/project/iid.")
    ref = mr_lib.parse_mr_url(web_url)
    diff_refs = mr.get("diff_refs") or {}
    if not all(diff_refs.get(k) for k in ("base_sha", "head_sha", "start_sha")):
        sys.exit("STOP: mr.json is missing diff_refs (base/head/start sha) — re-run the fetch step.")
    return ref, diff_refs


def _preview(plan: dict) -> None:
    inline = plan.get("inline", [])
    cov = plan.get("coverage", {})
    print(f"\nPlan: {len(inline)} inline comment(s), "
          f"{'1' if plan.get('summary_note') else '0'} summary note, "
          f"{'1 coverage comment' if cov.get('has_regression') else 'no coverage comment'}.")
    for i, c in enumerate(inline, 1):
        issue = c.get("body", "").splitlines()[0][:90] if c.get("body") else ""
        print(f"  {i}. [{c.get('severity','?')}] {c.get('path')}:{c.get('line')} — {issue}")


def post(ws: Path, force: bool = False, dry_run: bool = False) -> dict:
    plan = _load_plan(ws)
    ref, diff_refs = _load_ref_and_refs(ws)
    marker = ws / "posted.json"

    if marker.exists() and not force and not dry_run:
        prior = json.loads(marker.read_text())
        print(f"Already posted at {prior.get('at')}. "
              f"Re-run with --force to post again.")
        return prior

    _preview(plan)
    client = None if dry_run else gitlab_api.GitLabClient.from_env(ref.host, ref.project_id)
    cov = plan.get("coverage", {}) or {}

    result = {"inline": 0, "summary": 0, "coverage": 0, "skipped": []}

    for c in plan.get("inline", []):
        position = {
            "position_type": "text",
            "base_sha": diff_refs["base_sha"],
            "head_sha": diff_refs["head_sha"],
            "start_sha": diff_refs["start_sha"],
            "new_path": c["path"],
            "old_path": c["path"],
            "new_line": c["line"],
        }
        if dry_run:
            result["inline"] += 1
            continue
        try:
            client.create_mr_discussion(ref.mr_iid, c["body"], position)
            result["inline"] += 1
        except gitlab_api.GitLabError as e:
            # A rejected position (line not in diff) must not abort the rest — skip and report.
            result["skipped"].append({"path": c["path"], "line": c["line"], "error": str(e)})
            print(f"  ! skipped inline {c['path']}:{c['line']} — {e}")

    if plan.get("summary_note"):
        if dry_run:
            result["summary"] = 1
        else:
            client.create_mr_note(ref.mr_iid, plan["summary_note"])
            result["summary"] = 1

    if cov.get("has_regression") and cov.get("body"):
        if dry_run:
            result["coverage"] = 1
        else:
            client.create_mr_note(ref.mr_iid, cov["body"])
            result["coverage"] = 1

    summary = {
        "at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "mr_iid": ref.mr_iid,
        "web_url": (ws / "mr.json").exists() and json.loads((ws / "mr.json").read_text()).get("web_url"),
        "posted": result,
        "dry_run": dry_run,
    }
    if not dry_run:
        marker.write_text(json.dumps(summary, indent=2))

    verb = "DRY-RUN would post" if dry_run else "Posted"
    print(f"\n{verb}: {result['inline']} inline, {result['summary']} summary, "
          f"{result['coverage']} coverage"
          + (f", {len(result['skipped'])} skipped" if result["skipped"] else "") + ".")
    if summary["web_url"]:
        print(f"MR: {summary['web_url']}")
    return summary


def _selftest() -> None:
    """Offline check of plan/ref parsing and the dry-run flow (no network)."""
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        ws = Path(d)
        (ws / "mr.json").write_text(json.dumps({
            "web_url": "https://gitlab.com/acme/group/payments-service/-/merge_requests/482",
            "diff_refs": {"base_sha": "aaa", "head_sha": "bbb", "start_sha": "ccc"},
        }))
        (ws / "post-plan.json").write_text(json.dumps({
            "verdict": "needs_changes",
            "inline": [{"path": "src/Pay.ts", "line": 42, "severity": "HIGH", "body": "N+1 risk"}],
            "summary_note": "## summary",
            "coverage": {"has_regression": True, "body": "## 🧪 Coverage regression\n- drop"},
        }))
        out = post(ws, dry_run=True)
        assert out["posted"] == {"inline": 1, "summary": 1, "coverage": 1, "skipped": []}, out
        assert not (ws / "posted.json").exists(), "dry-run must not write the posted marker"
    print("review_post self-tests passed.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Deterministically post the MR review from post-plan.json.")
    ap.add_argument("--ws", required=False, help="workspace directory containing post-plan.json + mr.json")
    ap.add_argument("--force", action="store_true", help="post again even if posted.json exists")
    ap.add_argument("--dry-run", action="store_true", help="show what would post; POST nothing")
    ap.add_argument("--selftest", action="store_true", help="run offline self-tests and exit")
    args = ap.parse_args()

    if args.selftest:
        _selftest()
        return
    if not args.ws:
        ap.error("--ws is required (unless --selftest)")
    post(Path(args.ws), force=args.force, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
