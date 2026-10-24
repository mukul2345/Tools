#!/usr/bin/env python3
"""
submission_gate.py — deterministic VPT submission checks (Step 3), SOFT by design.

The existing Power hard-rejects an MR for many reasons. Per the approved plan (and the audit's
§5 trade-off), only *unambiguous* misses fail closed; everything else is a soft flag for the
human so the bot never false-rejects a valid MR.

  HARD (fail-closed):  no Jira key in the title ; already ran >= 3 review iterations
  SOFT (flag only):    missing testing evidence / regression summary / AI-analysis / coverage
                       proof ; multi-feature scope heuristic ; Mon-after-4pm develop cutoff ;
                       hotfix-to-master without QA sign-off note

Consumes structured MR data the spine already fetched over REST (no MCP, no LLM). Emits
`submission-gate.md` (human-readable) and returns a small dict via stdout JSON for the spine.

  python3 submission_gate.py --mr-json /tmp/ws/mr.json --notes-json /tmp/ws/mr-notes.json \
      --out /tmp/ws [--now 2026-07-13T16:30:00]
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import mr_lib

JIRA_IN_TITLE_RE = re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d+\b")

# Presence heuristics — searched (case-insensitive) across description + notes.
EVIDENCE_PATTERNS = {
    "testing_evidence": re.compile(
        r"(local(ly)? tested|screenshot|manual test|tested on|test evidence|verified locally)", re.I),
    "regression_summary": re.compile(
        r"(regression (analysis|summary|impact)|no (existing )?flows? (are )?affected|"
        r"unaffected flows?)", re.I),
    "ai_regression_output": re.compile(
        r"(cursor|copilot|ai[- ]?(assisted|generated)|kiro).{0,40}(regression|analysis)", re.I),
    "coverage_proof": re.compile(
        r"(coverage (report|before|after|delta)|no coverage drop|coverage:? \d)", re.I),
}


@dataclass
class GateResult:
    hard_failures: list[str] = field(default_factory=list)
    soft_flags: list[str] = field(default_factory=list)
    passed: bool = True

    def as_dict(self) -> dict:
        return {"passed": self.passed, "hard_failures": self.hard_failures,
                "soft_flags": self.soft_flags}


def _iteration_count(notes: list[dict]) -> int:
    """Approximate review rounds: count system/user notes signalling 'changes requested' cycles."""
    n = 0
    for note in notes:
        body = (note.get("body") or "").lower()
        if "requested changes" in body or "changes requested" in body or "unapproved" in body:
            n += 1
    return n


def _top_level_dirs(changed_paths: list[str]) -> set[str]:
    dirs = set()
    for p in changed_paths:
        if mr_lib.is_generated_or_vendored(p):
            continue
        parts = p.split("/")
        dirs.add(parts[1] if parts[0] == "src" and len(parts) > 1 else parts[0])
    return dirs


def evaluate(mr: dict, notes: list[dict], changed_paths: list[str], now: datetime) -> GateResult:
    res = GateResult()
    title = mr.get("title", "") or ""
    target = mr.get("target_branch", "") or ""
    description = mr.get("description", "") or ""
    haystack = "\n".join([description] + [(n.get("body") or "") for n in notes])

    # HARD 1 — Jira key in title
    if not JIRA_IN_TITLE_RE.search(title):
        res.hard_failures.append("No Jira ticket ID in the MR title.")

    # HARD 2 — iteration count >= 3
    iters = _iteration_count(notes)
    if iters >= 3:
        res.hard_failures.append(
            f"MR has already gone through {iters} review iterations (>=3). "
            f"Per VPT process it should be closed and re-raised.")

    # SOFT — evidence presence
    for label, rx in EVIDENCE_PATTERNS.items():
        if not rx.search(haystack):
            res.soft_flags.append(f"Could not detect {label.replace('_', ' ')} in the "
                                  f"description/comments (verify manually).")

    # SOFT — multi-feature scope heuristic
    dirs = _top_level_dirs(changed_paths)
    if len(dirs) >= 4:
        res.soft_flags.append(
            f"Change spans {len(dirs)} top-level areas ({', '.join(sorted(dirs))}) — "
            f"verify it is a single independent feature/fix.")

    # SOFT — Monday-after-4pm develop cutoff
    if target == "develop" and now.weekday() == 0 and now.hour >= 16:
        res.soft_flags.append("Today is Monday after 16:00 and target is `develop` — "
                              "sprint merge cutoff may apply.")

    # SOFT — hotfix to master without QA sign-off note
    if target in ("master", "main"):
        if not re.search(r"(qa (sign-?off|approv)|approved on (preprod|pre-prod))", haystack, re.I):
            res.soft_flags.append("Target is master/main (hotfix) but no QA sign-off / preprod "
                                  "approval note was found — confirm before merge.")

    res.passed = not res.hard_failures
    return res


def render_markdown(res: GateResult, mr: dict) -> str:
    lines = ["# Submission gate\n", f"MR: {mr.get('title','')}\n"]
    if res.hard_failures:
        lines.append("## 🚫 Hard failures (review blocked)")
        for h in res.hard_failures:
            lines.append(f"- [ ] {h}")
    else:
        lines.append("## ✅ Hard checks passed")
    lines.append("")
    if res.soft_flags:
        lines.append("## ⚠️ Soft flags (verify, not blocking)")
        for s in res.soft_flags:
            lines.append(f"- {s}")
    else:
        lines.append("## No soft flags")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mr-json", required=True)
    ap.add_argument("--notes-json", help="JSON array of MR notes/discussions (optional)")
    ap.add_argument("--files-json", help="JSON array of changed-file paths (optional)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--now", help="ISO datetime override for testing")
    args = ap.parse_args()

    mr = json.loads(Path(args.mr_json).read_text())
    notes = json.loads(Path(args.notes_json).read_text()) if args.notes_json and Path(args.notes_json).exists() else []
    paths = json.loads(Path(args.files_json).read_text()) if args.files_json and Path(args.files_json).exists() else []
    now = datetime.fromisoformat(args.now) if args.now else datetime.now()

    res = evaluate(mr, notes, paths, now)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "submission-gate.md").write_text(render_markdown(res, mr))
    print(json.dumps(res.as_dict()))
    return 0 if res.passed else 1


if __name__ == "__main__":
    # Inline self-test when run with no args.
    import sys
    if len(sys.argv) == 1:
        good = evaluate(
            {"title": "DMW-1234 fix null claim", "target_branch": "develop",
             "description": "Tested locally with screenshots. Regression analysis: no flows affected. "
                            "Cursor AI regression output attached. Coverage before 80 after 82."},
            [], ["src/pay/PaymentService.ts"], datetime(2026, 7, 14, 10, 0))
        assert good.passed and not good.soft_flags, good.as_dict()
        bad = evaluate({"title": "fix stuff", "target_branch": "develop", "description": ""},
                       [{"body": "changes requested"}, {"body": "changes requested"},
                        {"body": "changes requested"}],
                       ["src/a/x.ts", "src/b/y.ts", "src/c/z.ts", "src/d/w.ts"],
                       datetime(2026, 7, 13, 16, 30))
        assert not bad.passed and len(bad.hard_failures) == 2, bad.as_dict()
        assert any("spans 4" in s for s in bad.soft_flags)
        assert any("Monday" in s for s in bad.soft_flags)
        print("submission_gate self-tests passed.")
        sys.exit(0)
    sys.exit(main())
