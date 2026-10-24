# MR-Review Agent — Architecture (as built)

Living design doc. The Phase-1 critique/rationale lives in
`kiro-powers/gitlab-mr-review/docs/MR-REVIEW-ORCHESTRATION-AUDIT.md`; this records what was built.

## Thesis

Invert the control plane. A deterministic Python spine (`scripts/run_pipeline.py`) owns the
sequence and every mechanical check; the LLM is invoked at exactly one node (semantic review),
grounded by the spine's deterministic findings. Everything a lookup, regex, linter, type-checker,
or test runner can do is code, at 0 credits.

## Step audit (🟢 deterministic · 🟡 hybrid · 🔴 needs LLM)

| #   | Step                                                                         | Tag | Owner                                                     |
| --- | ---------------------------------------------------------------------------- | --- | --------------------------------------------------------- |
| 0   | Parse MR URL → ids                                                           | 🟢  | `mr_lib.parse_mr_url`                                     |
| 1   | Fetch MR meta / diffs / commits / pipeline                                   | 🟢  | `gitlab_api` (REST + PAT)                                 |
| 2   | Submission gate (soft)                                                       | 🟢  | `submission_gate.py`                                      |
| 3   | Clone @ source branch (temp)                                                 | 🟢  | spine + git                                               |
| 4   | `pnpm install` + `pnpm build`                                                | 🟢  | spine                                                     |
| 5   | Static gate: eslint + prettier + tsc + grep/AST                              | 🟢  | `review_static_gate.py`                                   |
| 6   | Coverage: jest on the changed files' co-located tests, no-regression vs base | 🟢  | `coverage_gate.py`                                        |
| 7   | Impact map: backtrace touched symbols → entry points                         | 🟢  | `node/impact_trace.mjs` (ts-morph) → `impact_fallback.py` |
| 8   | Jira + Confluence + cross-service MR context                                 | 🟢  | `context_gather.py` (Jira REST + dev-status)              |
| 9   | Assemble `review-input.md`                                                   | 🟢  | spine                                                     |
| 10a | **Find** — logic / tests / integration finders, parallel, over the change set | 🔴  | `review_stages.py` → headless kiro-cli (Sonnet)          |
| 10b | Merge — ground in each MR's diff, cross-finder dedupe, number                | 🟢  | `review_stages.merge_candidates`                          |
| 10c | **Verify** — fresh-context confirm/reject + confidence per finding           | 🔴  | headless kiro-cli (Opus)                                  |
| 10d | **Gap sweep** (deep) — missed issues, then verified                          | 🔴  | headless kiro-cli (Opus)                                  |
| 10e | Apply threshold → per-MR `review.md` + `verifier-dropped.json`               | 🟢  | `review_stages.review_changeset`                          |
| 11  | Grounding filter + dedup + nit-cap + verdict                                 | 🟢  | `review_finalize.py` (spine invokes, per MR)              |
| 12  | Post everything (inline CRITICAL/HIGH, summary + nits, coverage)             | 🟢  | `review_post.py` (REST + PAT)                             |
| 13  | Cleanup temp clone                                                           | 🟢  | spine                                                     |

## Impact map (call-graph backtrace) — why it's deterministic

Enumerating the callers of a changed symbol up to its entry points is mechanical, so it's a script
(`node/impact_trace.mjs`, ts-morph); judging what could break is the LLM's job. The tracer seeds on
declarations overlapping the diff's changed lines, walks `findReferences` upward, and stops at
entry points recognised for this stack: **Express controllers** (class `extends BaseController`)
and **SQS PubSub** (`*PubSub.ts`, or a class extending `Consumer`/`Producer`). Output is
`impact-map.md` (chains + blind spots + boundary crossings) fed into `review-input.md`.

**Honesty over completeness.** Static tracing cannot see through DI/factory dispatch
(`DataAccessFactory`, `TaskHandlerFactory`, interface methods) or across service boundaries — the
places this domain is most dynamic. Those are emitted as explicit ⚠️ blind-spot / boundary-crossing
markers so a missing edge reads as "trace stopped here," never "no impact." The semantic-review node
can now resolve many of these markers itself using **read-only** code-intelligence
(`find_references`, `goto_definition`, `search_symbols`, `get_document_symbols`, `get_hover`) plus
`grep`/`glob` over the clone — the deterministic map stays the grounding, the model chases only the
edges the map marks unresolved (and never rewrites: `pattern_rewrite` and all mutating ops are
withheld). Caps (depth 6, 25 callers/symbol, 500 nodes) bound cost. If Node/ts-morph is unavailable, `impact_fallback.py` gives a
labelled-approximate ripgrep pass.

The 🔴 surface is one node. The grounding-enforcement seam (drop findings whose `file:line` ∉ the
changed-line set) is a scripted post-filter, not a model decision.

## Find → verify, not one pass

One model pass is one sample: re-running it on another model drops some findings and adds others.
So recall and precision are separate stages with separate sessions. Finders are narrow and
optimised for recall; the verifier sees only the candidate table (not the finders' reasoning),
checks each against the code, and decides CONFIRMED/REJECTED with a 0-100 confidence. Only
CONFIRMED findings at or above `--threshold` post; the rest are listed in `review-final.md` for
audit. `deep` adds a gap sweep whose findings are verified the same way. This mirrors the pattern
the hosted reviewers converged on (parallel narrow reviewers + independent confidence-scored
validation, e.g. the Claude Code code-review plugin's ≥80 filter).

## Change sets

Several MR URLs are one change set. Each MR keeps its own workspace, grounding index and post
plan (an inline comment must anchor to that MR's diff), but every stage reads `changeset.md`, so
the integration finder can check producer↔consumer contracts (fields, enums, routes, message
shapes, package version pins, deploy order) across services. `--related` MRs are context only.
`--seed` is the author's intent, checked like an acceptance criterion.

## One agent profile, many sessions

All stages use one read-only profile (`agents/mr-reviewer.json`), materialised as a
workspace-local profile inside the change-set dir, so a run never depends on `~/.kiro/agents`.
Stage behaviour comes from the instruction file (`prompts/*.md`, composed into `<cs>/run/`), and
the model per stage comes from `--model`. Separation of duties is still done by tool scope: read
tools, a write tool limited to `/tmp/kiro-mr-review/**`, read-only shell, no post/merge tools.

## Hand-off contracts (`*-EXEC` + tables + raw fenced diff — never JSON-with-code)

- `review-input.md` — DRIVER → LLM. `REVIEW-INPUT-EXEC` control block (ids, branches, pipeline
  status, deterministic-findings count) + layer-classified changed files + the static findings
  table + pointers to `full.diff` / `jira-context.md`.
- `review.md` — synthesized by `review_stages.py` from the verified findings (schema_version 2). `REVIEW-EXEC` block (status, advisory verdict, counts) + a
  "Semantic findings" pipe table (`file:line | dimension | severity | issue | suggested_fix`) +
  business-logic alignment table + regression prose.

`review_finalize.py` parses only the EXEC block + tables, filters/merges/dedups/caps, recomputes the
verdict from counts, and emits `post-plan.json` (inline comments + summary note). The model only
ever writes markdown and never escapes a diff.

## Reuse map (from the sibling)

| Need                                                                  | Reused                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*-EXEC` parsing                                                      | `pipeline_lib.extract_exec_block` / `parse_exec_block` (verbatim)                                                                                                 |
| diff → added-line set                                                 | `mr_lib.added_lines_from_diff` (ported from `coverage_gate`)                                                                                                      |
| coverage no-regression                                                | `coverage_gate.py` (adapted: runs each changed file's co-located `Tests/<Name>.test.ts` only — never `--findRelatedTests` on source, which pulls the whole suite) |
| scripted standards gate                                               | `review_static_gate.py` (extends `compliance_gate.py`'s grep pattern)                                                                                             |
| spine shape, checkpointing, `--from`/`--force`                        | `run_pipeline.py`                                                                                                                                                 |
| read-only agent JSON, keychain launcher | `mr-reviewer.json`, `bin/mr-review.js` (npm `@dfg/mr-review`)                                                                                                               |

New MR-specific code: `mr_lib.py`, `gitlab_api.py`, `context_gather.py`, `submission_gate.py`,
`review_static_gate.py`, `review_finalize.py`, `node/impact_trace.mjs` (ts-morph),
`impact_fallback.py`.

## Known seams / trade-offs

- **Local test execution** requires `pnpm install` to succeed (private registry auth) and tests
  that run offline. If the build fails, the spine records it and skips the static-tool + coverage
  steps (grep rules still run); fall back to CI coverage in that case.
- **dev-status API** (Jira development panel → linked MRs) is an internal endpoint; casing of
  `applicationType` varies by instance. `context_gather` tries variants and falls back to regex over
  the ticket description/comments when a dev didn't link the MR.
- **Inline comment positioning** needs `diff_refs` (base/head/start SHAs); the agent fetches them
  via `get_merge_request` before posting.
- Determinism costs flexibility: soft-gate presence checks fail closed only on unambiguous misses
  (no Jira key, iterations ≥ 3) and otherwise emit soft flags, to avoid false-rejecting valid MRs.
- **Impact-tracer scope:** loading a large monorepo's TS project can be slow/memory-heavy, and
  project-reference or path-alias setups may load only part of the graph — the map degrades to
  partial (labelled), never wrong. `impact_trace.mjs` runs independent of the target's build (it
  uses its own TypeScript + the repo's tsconfig), so it still works when `pnpm build` fails.
