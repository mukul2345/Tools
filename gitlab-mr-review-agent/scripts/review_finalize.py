#!/usr/bin/env python3
"""
review_finalize.py — Steps 8-9, run by the SPINE after the review stages write review.md (0 credits).

Keeping these deterministic (not model judgment) is the whole point of the architecture:
  8. Grounding filter — drop any LLM finding whose file:line is NOT within the diff's changed
     lines (+/- small tolerance). No commenting on unchanged code.
  9. Merge with the deterministic static findings, dedupe, cap LOW nits, and RECOMPUTE the verdict
     from severity counts (the model's verdict is advisory only — never trusted, never an
     approve/merge).

Inputs (all in the workspace):
  review.md            — the LLM node's output (REVIEW-EXEC block + a semantic findings table +
                         business-logic alignment + regression prose)
  static-findings.json — deterministic findings from review_static_gate
  changed-index.json   — {path: [changed line numbers]} written by the spine (grounding source)

Outputs:
  review-final.md      — the human-facing report (verdict recomputed, findings merged/capped)
  post-plan.json       — exactly what to post: inline[] (path,line,body) + summary_note (body)

  python3 review_finalize.py --ws /tmp/kiro-mr-review/<ws> [--nit-cap 10]
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import mr_lib
import pipeline_lib

SEV_EMOJI = {"CRITICAL": "🔴", "HIGH": "🟠", "LOW": "🔵"}


# --------------------------------------------------------------------------------------
# Parse the LLM's markdown findings table
# --------------------------------------------------------------------------------------

def parse_pipe_table(text: str, header_contains: str) -> list[list[str]]:
    """Return data rows (list of cell lists) of the first pipe-table whose header row contains
    `header_contains`. Skips the header + separator rows."""
    rows: list[list[str]] = []
    lines = text.splitlines()
    in_table = False
    for line in lines:
        if "|" not in line:
            if in_table:
                break
            continue
        cells = [c.strip().strip("`") for c in line.strip().strip("|").split("|")]
        if not in_table:
            if header_contains.lower() in line.lower():
                in_table = True
            continue
        if set("".join(cells)) <= set("-: "):  # separator row
            continue
        rows.append(cells)
    return rows


def findings_from_review(review_text: str) -> list[mr_lib.Finding]:
    """Parse the 'Semantic findings' table -> Finding list.
    Expected columns: file:line | dimension | severity | issue | suggested_fix
    """
    out: list[mr_lib.Finding] = []
    for cells in parse_pipe_table(review_text, "file:line"):
        if len(cells) < 4:
            continue
        location, dimension, severity, issue = cells[0], cells[1], cells[2].upper(), cells[3]
        fix = cells[4] if len(cells) > 4 else ""
        if severity not in mr_lib.SEVERITY_ORDER:
            continue
        out.append(mr_lib.Finding(location=location, severity=severity,
                                  dimension=dimension.lower().replace(" ", "_"),
                                  issue=issue, suggested_fix=fix, source="llm"))
    return out


def static_findings(ws: Path) -> list[mr_lib.Finding]:
    p = ws / "static-findings.json"
    if not p.exists():
        return []
    data = json.loads(p.read_text())
    return [mr_lib.Finding(location=d["location"], severity=d["severity"],
                           dimension=d.get("dimension", "code_quality"),
                           issue=d["issue"], suggested_fix="", source="static")
            for d in data]


def load_changed_index(ws: Path) -> dict[str, set[int]]:
    p = ws / "changed-index.json"
    if not p.exists():
        return {}
    return {k: set(v) for k, v in json.loads(p.read_text()).items()}


def snap_to_changed_line(location: str, changed_index: dict[str, set[int]],
                         tolerance: int = 3) -> tuple[str, int] | None:
    """Anchor a finding to an EXACT new-side line that appears in the diff.

    GitLab only accepts an inline comment on a line that is actually part of the diff. `is_grounded`
    is deliberately lenient (±tolerance, suffix path match) so a finding NEAR a change still counts;
    but posting inline on a line that isn't in a hunk fails with `line_code can't be blank`. So for
    posting we snap to the nearest ACTUAL changed line within tolerance and post THAT line. Returns
    (reported_path, exact_changed_line), or None if the finding can't be anchored to any changed
    line (file-level findings, or findings too far from a hunk) — those are routed to the summary.

    When there is no changed-line index at all (degenerate/off-line run), fall back to the parsed
    location so behaviour matches the pre-snap pipeline.
    """
    parsed = mr_lib.parse_location(location)
    if parsed is None:
        return None
    path, line = parsed
    if not changed_index:
        return path, line
    best: tuple[int, int] | None = None  # (distance, changed_line)
    for key, lines in changed_index.items():
        if not (key == path or key.endswith("/" + path) or path.endswith("/" + key)
                or key.endswith(path) or path.endswith(key)):
            continue
        for cl in lines:
            dist = abs(line - cl)
            if dist <= tolerance and (best is None or dist < best[0]):
                best = (dist, cl)
    if best is None:
        return None
    return path, best[1]


def coverage_plan(ws: Path) -> dict:
    """Read coverage-findings.json (written by coverage_gate.py) and build ONE consolidated
    coverage-regression comment. Returns {has_regression, body, violations}.

    Deliberately consolidated into a single comment (per the review requirement): coverage
    regressions are a file/multi-line concern, so one MR note is clearer than scattered inline
    nits and guarantees the regression is posted rather than lost in the summary."""
    p = ws / "coverage-findings.json"
    if not p.exists():
        return {"has_regression": False, "body": "", "violations": []}
    try:
        data = json.loads(p.read_text())
    except json.JSONDecodeError:
        return {"has_regression": False, "body": "", "violations": []}
    violations = data.get("violations", []) or []
    if not violations:
        return {"has_regression": False, "body": "", "violations": []}
    lines = [
        "## 🧪 Coverage regression",
        "> Deterministic coverage gate — one consolidated comment. No-regression rule + "
        "added-lines-must-be-covered rule, run on the changed files only.",
        "",
    ]
    lines += [f"- {v}" for v in violations]
    lines += ["", "_Fix: add/extend tests for the changed files so coverage does not drop and every "
              "added line is exercised._"]
    return {"has_regression": True, "body": "\n".join(lines), "violations": violations}


def extract_section(text: str, header: str) -> str:
    """Return the markdown under a `## header` up to the next `## `."""
    m = re.search(rf"^#+\s*{re.escape(header)}.*?$(.*?)(?=^#+\s|\Z)", text,
                  re.MULTILINE | re.DOTALL | re.IGNORECASE)
    return m.group(1).strip() if m else ""


# --------------------------------------------------------------------------------------
# Build comment bodies
# --------------------------------------------------------------------------------------

def inline_body(f: mr_lib.Finding) -> str:
    emoji = SEV_EMOJI.get(f.severity, "")
    body = f"{emoji} [{f.severity}] {f.issue}"
    if f.suggested_fix:
        body += f"\n\n**Suggested fix:**\n{f.suggested_fix}"
    if f.source == "static":
        body += "\n\n> _Flagged by the deterministic static gate._"
    return body


def build(ws: Path, nit_cap: int) -> dict:
    review_text = (ws / "review.md").read_text() if (ws / "review.md").exists() else ""
    changed_index = load_changed_index(ws)

    llm = findings_from_review(review_text)
    grounded, dropped = [], []
    for f in llm:
        if not changed_index or mr_lib.is_grounded(f.location, changed_index):
            grounded.append(f)
        else:
            dropped.append(f)

    # Static findings are already scoped to changed lines by review_static_gate, but grounding-filter
    # them here too as a safety net so NOTHING outside the diff is ever posted (belt and braces).
    static_grounded = [f for f in static_findings(ws)
                       if not changed_index or mr_lib.is_grounded(f.location, changed_index)]
    merged = mr_lib.dedupe_findings(grounded + static_grounded)
    capped, nits_dropped = mr_lib.cap_low_severity(merged, cap=nit_cap)

    # Coverage regression -> ONE consolidated finding + comment (never lost). Added AFTER the
    # grounding filter (its location is synthetic, not a diff line) and AFTER the nit-cap (it is
    # HIGH and must always survive), so it always reaches the verdict, action items, and posting.
    cov = coverage_plan(ws)
    if cov["has_regression"]:
        capped.append(mr_lib.Finding(
            location="coverage", severity="HIGH", dimension="test_coverage",
            issue=f"Coverage regression on changed files ({len(cov['violations'])} issue(s)) "
                  f"— see the consolidated coverage comment.",
            source="coverage"))

    capped = mr_lib.sort_findings(capped)
    verdict = mr_lib.compute_verdict(capped)

    # Split the inline-eligible findings: anchor each to an EXACT changed line so GitLab accepts it
    # as an inline comment. Anything that can't be anchored (file-level findings, or findings off a
    # hunk) is routed to the summary note instead of silently failing to post.
    inline_plan: list[dict] = []
    summary_only: list[mr_lib.Finding] = []
    nits: list[mr_lib.Finding] = []
    for f in capped:
        if f.source == "coverage":
            continue  # handled by the dedicated consolidated coverage comment
        if f.severity == "LOW":
            nits.append(f)  # never inline: one collapsed "Nits" block in the summary note
            continue
        # Every CRITICAL/HIGH that anchors to a changed line goes inline, whatever its dimension —
        # a regression or broken-AC finding on a specific line is exactly what reviewers want next
        # to the code. It is also listed in the summary's action items.
        snap = snap_to_changed_line(f.location, changed_index)
        if snap is None:
            summary_only.append(f)
            continue
        path, line = snap
        inline_plan.append({"path": path, "line": line, "severity": f.severity,
                            "dimension": f.dimension, "body": inline_body(f)})

    # summary note: business logic + regression prose (verbatim) + coverage + verdict + action items
    biz = extract_section(review_text, "Business-logic alignment") or extract_section(review_text, "Business Logic")
    regr = extract_section(review_text, "Regression")
    cross = extract_section(review_text, "Cross-MR integration")
    action_items = [f"- [ ] {SEV_EMOJI.get(f.severity,'')} [{f.severity}] `{f.location}` — {f.issue}"
                    for f in capped if f.severity != "LOW"]

    verdict_label = {"blocked": "❌ Blocked", "needs_changes": "⚠️ Needs Changes",
                     "approved_with_notes": "✅ Approved (with notes)"}[verdict]

    note = ["## 🤖 MR Review Summary",
            "> Automated review — deterministic gates + independently verified semantic findings. "
            "Advisory only; a human owns approve/merge.\n",
            "### Business-logic assessment", biz or "_See inline comments._", "",
            "### Regression risks", regr or "_None identified._", ""]
    if cross:
        note += ["### Cross-MR integration", cross, ""]
    if cov["has_regression"]:
        note += [cov["body"], ""]
    if summary_only:
        note += ["### Additional findings (not anchored to a changed line)"]
        note += [f"- {SEV_EMOJI.get(f.severity,'')} [{f.severity}] `{f.location}` — {f.issue}"
                 for f in summary_only]
        note += [""]
    note += [f"### Verdict\n{verdict_label}", "", "### Action items"]
    note += action_items or ["- None."]
    if nits:
        note += ["", f"<details><summary>🔵 Nits ({len(nits)}) — optional</summary>", ""]
        note += [f"- `{f.location}` — {f.issue}" for f in nits]
        note += ["", "</details>"]
    summary_note = "\n".join(note)

    verifier_dropped = []
    vd = ws / "verifier-dropped.json"
    if vd.exists():
        verifier_dropped = json.loads(vd.read_text())

    # human report file
    report = [f"# MR Review — final (verdict: {verdict_label})\n",
              f"- LLM findings: {len(llm)} | grounded: {len(grounded)} | "
              f"dropped (outside diff): {len(dropped)} | rejected by verifier: {len(verifier_dropped)}",
              f"- After merge+dedupe+cap: {len(capped)} finding(s); LOW nits dropped: {nits_dropped}",
              f"- Posting split: {len(inline_plan)} inline, {len(summary_only)} summary-only, "
              f"{len(nits)} nits (collapsed in summary)"
              + (", 1 consolidated coverage comment" if cov["has_regression"] else ""),
              "",
              "## Findings"]
    for f in capped:
        report.append(f"{SEV_EMOJI.get(f.severity,'')} [{f.severity}] `{f.location}` "
                      f"({f.dimension}, {f.source}) — {f.issue}")
    if dropped:
        report.append("\n## Dropped (not grounded in the diff — not posted)")
        for f in dropped:
            report.append(f"- `{f.location}` — {f.issue}")
    if verifier_dropped:
        report.append("\n## Rejected by the verifier (not posted — audit only)")
        for d in verifier_dropped:
            report.append(f"- `{d.get('location')}` [{d.get('severity')}] — {d.get('issue')} "
                          f"→ {d.get('decision')} ({d.get('confidence')}): {d.get('reason')}")
    (ws / "review-final.md").write_text("\n".join(report))

    plan = {"verdict": verdict, "inline": inline_plan, "summary_note": summary_note,
            "coverage": {"has_regression": cov["has_regression"], "body": cov["body"]},
            "stats": {"llm": len(llm), "grounded": len(grounded), "dropped": len(dropped),
                      "verifier_rejected": len(verifier_dropped),
                      "final": len(capped), "nits_dropped": nits_dropped, "nits": len(nits),
                      "inline": len(inline_plan), "summary_only": len(summary_only),
                      "coverage_regression": cov["has_regression"]}}
    (ws / "post-plan.json").write_text(json.dumps(plan, indent=2))
    return plan


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ws", required=True, help="workspace dir containing review.md etc.")
    ap.add_argument("--nit-cap", type=int, default=10)
    args = ap.parse_args()
    plan = build(Path(args.ws), args.nit_cap)
    print(json.dumps(plan["stats"]))
    print(f"[finalize] verdict={plan['verdict']} inline={len(plan['inline'])} "
          f"-> wrote review-final.md + post-plan.json")
    return 0


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 1:
        import tempfile
        ws = Path(tempfile.mkdtemp())
        (ws / "changed-index.json").write_text(json.dumps({"src/Pay.ts": [40, 41, 42]}))
        (ws / "static-findings.json").write_text(json.dumps(
            [{"location": "src/Pay.ts:41", "severity": "HIGH", "dimension": "code_quality",
              "issue": "any type", "source": "static"}]))
        # coverage regression -> one consolidated comment + a HIGH finding
        (ws / "coverage-findings.json").write_text(json.dumps(
            {"status": "fail", "violations": ["src/Pay.ts: lines regressed 90.0% -> 80.0%"]}))
        (ws / "review.md").write_text(
            "# --- REVIEW-EXEC ---\nstatus: reviewed\nverdict: needs_changes\n# --- END REVIEW-EXEC ---\n\n"
            "## Semantic findings\n"
            "| file:line | dimension | severity | issue | suggested_fix |\n"
            "|---|---|---|---|---|\n"
            "| `src/Pay.ts:42` | business_logic | CRITICAL | AC-2 not implemented | add guard |\n"
            "| `src/Pay.ts:44` | code_quality | HIGH | off-hunk-but-near | tidy |\n"   # snaps to 42
            "| `src/Other.ts:9` | code_quality | LOW | naming | rename |\n"   # not grounded -> dropped
            "| `src/Pay.ts:40` | code_quality | LOW | tiny nit | rename |\n"   # LOW -> nits, never inline
            "\n## Business-logic alignment\nAC-2 missing.\n\n## Regression risks\nShared cache.\n")
        plan = build(ws, nit_cap=10)
        assert plan["verdict"] == "blocked", plan["verdict"]   # CRITICAL present
        assert plan["stats"]["dropped"] == 1, plan["stats"]    # Other.ts:9 outside diff
        # inline entries only reference changed files, and each line is an ACTUAL changed line
        changed = {"src/Pay.ts": {40, 41, 42}}
        for c in plan["inline"]:
            assert c["path"] == "src/Pay.ts", c
            assert c["line"] in changed["src/Pay.ts"], c   # snapped onto a real diff line (44 -> 42)
        assert "src/Other.ts" not in {c["path"] for c in plan["inline"]}
        # coverage surfaced as one consolidated comment + factored into the summary note
        assert plan["coverage"]["has_regression"] is True, plan["coverage"]
        assert "Coverage regression" in plan["coverage"]["body"]
        assert "🧪 Coverage regression" in plan["summary_note"]
        assert plan["stats"]["coverage_regression"] is True
        assert all(c["severity"] != "LOW" for c in plan["inline"]), plan["inline"]
        assert any(c["dimension"] == "business_logic" for c in plan["inline"]), plan["inline"]
        assert "Nits (1)" in plan["summary_note"] and "tiny nit" in plan["summary_note"]
        print("review_finalize self-tests passed:", plan["stats"])
        sys.exit(0)
    sys.exit(main())
