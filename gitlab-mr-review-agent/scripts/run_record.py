#!/usr/bin/env python3
"""
run_record.py — one structured record per `mr-review` run (monitoring step 1, no infrastructure).

Every run — success, failure, or Ctrl-C — writes:
  <change-set dir>/run.json                       the full record for that run (when a change set exists)
  ~/.local/state/mr-review/runs.jsonl            one line per run, append-only (MR_REVIEW_STATE_DIR)

Field names follow the OpenTelemetry GenAI semantic conventions where one exists
(`gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.request.model`) so a later CloudWatch
(step 2) or OTLP exporter maps 1:1. kiro-cli reports credits, not tokens, so usage is
`mr_review.credits` rather than `gen_ai.usage.*`.

Never raises: a broken record must not fail or mask a review.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import time
import traceback
import uuid
from pathlib import Path

SCHEMA_VERSION = 1
PROGRESS: dict = {"step": None}   # updated by run_pipeline as it moves through the steps


def state_dir() -> Path:
    return Path(os.environ.get("MR_REVIEW_STATE_DIR",
                               Path.home() / ".local" / "state" / "mr-review"))


def _json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def _version() -> str:
    if os.environ.get("MR_REVIEW_VERSION"):
        return os.environ["MR_REVIEW_VERSION"]
    return _json(Path(__file__).resolve().parent.parent / "package.json", {}).get("version", "dev")


class RunRecord:
    def __init__(self, args) -> None:
        self.args = args
        self.run_id = str(uuid.uuid4())
        self.started_at = _now()
        self._t0 = time.monotonic()
        self.works: list = []     # review_stages.MRWork, set once prep finishes
        self.cs: Path | None = None
        self.outcome = "success"
        self.failed_step: str | None = None
        self.error: str | None = None

    def fail(self, exc: BaseException) -> None:
        if isinstance(exc, SystemExit) and exc.code in (0, None):
            return  # argparse --help/--version or a clean early exit
        self.outcome = "cancelled" if isinstance(exc, KeyboardInterrupt) else "failed"
        self.failed_step = PROGRESS.get("step")
        msg = exc.code if isinstance(exc, SystemExit) else f"{type(exc).__name__}: {exc}"
        self.error = str(msg)[:300]

    # ------------------------------------------------------------------ build
    def _options(self) -> dict:
        a = self.args
        return {"depth": a.depth, "engine": a.engine, "find_model": a.find_model,
                "verify_model": a.verify_model, "threshold": a.threshold, "parallel": a.parallel,
                "from_step": a.from_step, "force": a.force, "dry_run": a.dry_run,
                "no_post": a.no_post, "no_agent": a.no_agent,
                "seed_given": bool(a.seed or a.seed_file), "related_count": len(a.related)}

    def _mr(self, w) -> dict:
        ws: Path = w.ws
        plan = _json(ws / "post-plan.json", {})
        stats = plan.get("stats", {})
        posted = _json(ws / "posted.json", {}).get("posted")
        would = {"inline": len(plan.get("inline", [])), "summary": int(bool(plan.get("summary_note"))),
                 "coverage": int(bool(plan.get("coverage", {}).get("has_regression")))}
        return {
            "key": w.key, "repo": w.ref.clone_slug, "iid": w.ref.mr_iid,
            "changed_files": len(_json(ws / "changed-files.json", [])),
            "build_ok": (ws / ".build-ok").exists(),
            "static_findings": len(_json(ws / "static-findings.json", [])),
            "coverage_regression": bool(stats.get("coverage_regression")),
            "verdict": plan.get("verdict"),
            "findings_final": stats.get("final"),
            "verifier_rejected": stats.get("verifier_rejected"),
            "nits": stats.get("nits"),
            # real counts after posting; plan counts (flagged) on --dry-run / --no-post
            "posted": posted if posted and not self.args.dry_run else {**would, "dry_run": True},
        }

    def _stages(self) -> list[dict]:
        if not self.cs:
            return []
        out = []
        for name, u in _json(self.cs / "credits.json", {}).items():
            out.append({"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": name,
                        "gen_ai.request.model": u.get("model"),
                        "mr_review.credits": 0.0 if u.get("reused") else u.get("credits", 0.0),
                        "duration_s": 0 if u.get("reused") else u.get("seconds", 0),
                        "turns": 0 if u.get("reused") else u.get("turns", 0),
                        "reused": bool(u.get("reused"))})
        return out

    def build(self) -> dict:
        stages = self._stages()
        return {
            "schema_version": SCHEMA_VERSION, "run_id": self.run_id, "tool_version": _version(),
            "started_at": self.started_at, "ended_at": _now(),
            "duration_s": round(time.monotonic() - self._t0),
            "outcome": self.outcome, "failed_step": self.failed_step, "error": self.error,
            "options": self._options(),
            "mr_count": len(self.args.mr_urls),
            "change_set": self.cs.name if self.cs else None,
            "mrs": [self._mr(w) for w in self.works],
            "stages": stages,
            "findings": _json(self.cs / "stats.json", {}) if self.cs else {},
            "credits_spent": round(sum(s["mr_review.credits"] for s in stages), 3),
        }

    # ------------------------------------------------------------------ write
    def write(self, workroot: Path) -> None:
        try:
            rec = self.build()
            line = json.dumps(rec, separators=(",", ":"))
            if self.cs:
                (self.cs / "run.json").write_text(json.dumps(rec, indent=2))
            sd = state_dir()
            sd.mkdir(parents=True, exist_ok=True)
            with open(sd / "runs.jsonl", "a") as fh:
                fh.write(line + "\n")
            print(f"[spine] run record: {rec['outcome']}, {rec['credits_spent']} credits, "
                  f"{rec['duration_s']}s -> {sd / 'runs.jsonl'}", flush=True)
        except Exception:  # never let telemetry fail or mask the review
            print("[spine] WARNING: could not write the run record:\n"
                  + traceback.format_exc(limit=2), flush=True)


def _selftest() -> None:
    import argparse
    import tempfile
    import mr_lib
    import review_stages

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        os.environ["MR_REVIEW_STATE_DIR"] = str(root / "state")
        args = argparse.Namespace(depth="standard", engine="v2", find_model="s", verify_model="o",
                                  threshold=70, parallel=2, from_step=None, force=False,
                                  dry_run=True, no_post=False, no_agent=False, seed="x",
                                  seed_file=None, related=[], mr_urls=["u"])
        ws = root / "svc-1"
        ws.mkdir()
        (ws / "post-plan.json").write_text(json.dumps({
            "verdict": "blocked", "inline": [{}, {}], "summary_note": "s",
            "coverage": {"has_regression": False},
            "stats": {"final": 3, "verifier_rejected": 4, "nits": 1}}))
        (ws / ".build-ok").write_text("ok")
        cs = root / "cs-1"
        cs.mkdir()
        (cs / "credits.json").write_text(json.dumps({
            "find-logic": {"model": "s", "credits": 2.5, "seconds": 60, "turns": 9, "reused": False},
            "verify": {"model": "o", "credits": 4.0, "seconds": 90, "turns": 5, "reused": True}}))
        (cs / "stats.json").write_text(json.dumps({"raw": 7, "confirmed": 3, "rejected": 4}))

        rec = RunRecord(args)
        rec.works = [review_stages.MRWork(mr_lib.parse_mr_url(
            "https://gitlab.com/g/svc/-/merge_requests/1"), ws, {})]
        rec.cs = cs
        PROGRESS["step"] = "review"
        rec.fail(SystemExit("STOP: verify returned nothing"))
        rec.write(root)
        r = json.loads((cs / "run.json").read_text())
        assert r["outcome"] == "failed" and r["failed_step"] == "review", r
        assert r["credits_spent"] == 2.5, r          # reused stage costs 0 this run
        assert r["mrs"][0]["posted"] == {"inline": 2, "summary": 1, "coverage": 0, "dry_run": True}
        assert r["stages"][0]["gen_ai.request.model"] == "s"
        lines = (root / "state" / "runs.jsonl").read_text().splitlines()
        assert len(lines) == 1 and json.loads(lines[0])["run_id"] == r["run_id"]

        clean = RunRecord(args)
        clean.fail(SystemExit(0))                     # --help: not a failure
        assert clean.outcome == "success"
    print("run_record self-tests passed.")


if __name__ == "__main__":
    _selftest()
