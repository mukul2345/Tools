# Task Implementer — Architecture & Decisions

Living design doc for the `jira-gitlab-task-implementer`. It is the spec-driven **sibling** the
bug-fixer's `docs/ARCHITECTURE.md` §3 anticipated ("SEPARATE sibling agent … reuses the shared
machinery"). Read alongside the bug-fixer docs; this captures only what differs.

---

## 1. Goal

Given a Jira **subtask** and a Kiro spec (`requirements.md` / `design.md` / `tasks.md`), implement a
selected set of tasks on a GitLab repo to team standards, run the gates, push a branch, optionally
open a compliant MR, and report back on the subtask — with the input-validation gates enforced
before any model spend.

Tools in play: Jira (Atlassian Rovo MCP + a read-only REST client), GitLab (@zereight/mcp-gitlab
MCP + git over a PAT), Kiro CLI, macOS.

---

## 2. Why this is a separate tool, not a bug-fixer mode

The bug-fixer's guardrails (verify a proposed fix, minimal diff, one-bug-per-run, mirror existing
behaviour) actively conflict with implementing a spec (multi-task, new code, execute a `tasks.md`
checklist). So this is its own agent + spine, reusing the shared substructure: clone → implement →
tests/coverage → compliance → MR → optional verification artifacts.

Key differences from the bug-fixer:

| Aspect          | Bug-fixer                                    | Task-implementer                                    |
| --------------- | -------------------------------------------- | --------------------------------------------------- |
| Source of truth | Analyzer `findings.md` (verified root cause) | The Kiro **spec** (`tasks.md`) — no analyzer        |
| LLM nodes       | 2 (Opus analyze + Sonnet fix)                | **1** (implement)                                   |
| Repo discovery  | Component→repo map                           | **Explicit `repo_url`** in the config               |
| Config delivery | `KIRO-EXEC` block in the Jira ticket         | A **per-run YAML** file                             |
| Unit of work    | one bug                                      | a **selected set of tasks** of a subtask            |
| Who clones      | the agent                                    | the **spine** (so preflight gates run at 0 credits) |
| Default model   | Sonnet (fix)                                 | **Opus** (greenfield judgment)                      |

---

## 3. Orchestration: deterministic spine, one LLM node

`scripts/run_task_pipeline.py` owns the sequence and calls the LLM only at `implement`. Everything
else is a computation, not a judgment, so it runs in Python at 0 credits:

```
preflight → gather → references → clone → select → branch → implement(LLM·Opus) → coverage → compliance → report
└──────────────────────── hard gates + context, 0 credits ──────────────────┘              └── re-verify ──┘
```

**The spine clones (unlike the bug-fixer, where the agent clones).** Because `repo_url` is explicit
and task selection needs the real `tasks.md`, having the spine clone + parse + select means all the
input checks — repo reachable, branches present, spec present, task ids valid — are **hard gates
that fire before a single token is spent.** The agent is handed an already-cloned repo on the work
branch plus a `task-brief.json`, so its prompt is lean.

**The gate is the file the agent writes.** The agent emits `implementation.md` with an `IMPL-EXEC`
block (`status`, `tests_passed`, `tasks_implemented`, …). The spine reads it to decide whether to
run the coverage/compliance re-checks. Steps checkpoint to files, so a re-run resumes at the first
missing output.

**Why the agent still pushes + opens the MR.** The MR needs the GitLab MCP (`create_merge_request`,
`get_users`) and the Jira comment needs the Rovo MCP — both live with the agent. So the agent does
implement → run the gate scripts (pre-push hard gate) → push → MR → Jira comment, and the spine
re-runs coverage + compliance afterward as independent defense in depth (the same posture as the
bug-fixer).

### 3.5 Context steps: gather + references (0-credit grounding)

Two deterministic steps enrich the implement node without spending tokens on exploration. Both are
**best-effort** — a failure logs a warning and the pipeline continues, because the spec is the
source of truth; only the preflight/clone/select gates are hard STOPs.

- **gather** (`jira_gather.py`, extended from the bug-fixer's). Walks the linked-issue graph —
  parent, child, sibling, and any relates/blocks links, plus ticket keys mentioned in text — pulls
  every issue's description + comments (ADF flattened to text), and now also **fetches linked
  Confluence page content**. Confluence page ids are extracted from remote links and from inline
  wiki URLs (`/wiki/.../pages/<id>` and `?pageId=<id>`, plus link-mark hrefs surfaced from ADF);
  each page is fetched via `/wiki/rest/api/content/{id}?expand=body.storage` and its storage XHTML
  is flattened to text. Everything is written to a single chronological `ticket-history.md` (+ a
  `.json` sidecar with a `confluence` array). Same Atlassian token as the preflight (it works for
  both Jira and Confluence on one site). Capped by `jira.max_depth/max_tickets/max_confluence`.

- **references** (`reference_gather.py`, new). Clones each configured reference repo **shallow +
  read-only** and greps the grounding `keywords` (global + per-source) across the sources (scoped to
  `paths` when given), extracting matched regions with context and `»`-marked hit lines into a
  single `reference-context.md` digest, size-capped by a byte budget. That digest is the agent's
  entry point (grounding without crawling); the full clones under `references/repos/` remain
  available for deeper reading. No keywords + explicit paths ⇒ include those files; no keywords +
  whole repo ⇒ a tree listing with a note. References are strictly read-only — the agent is told
  never to edit or push them.

Both feed the agent via a `context` block in `task-brief.json` (`ticket_history_md`,
`reference_context_md`, `references_dir`, `confluence_count`); any value may be `null` and the agent
proceeds on the spec alone. The `git` URL normalizer (`token_clone_url`) and `repo_name_from_url`
live in `task_pipeline_lib` so the spine and `reference_gather` share one implementation.

---

## 4. Configuration model

A single per-run YAML (`config/run.example.yml`) carries all inputs. Rationale: ~12 parameters is
too many for CLI flags, and unlike the bug-fixer there's no ticket to embed a `KIRO-EXEC` block in.
The file mirrors the team's existing `variables.yml` style. `task_pipeline_lib.load_run_config`
validates it and raises `ConfigError` (a hard-gate STOP) on anything missing or malformed.

**Task-id footgun.** In YAML, unquoted `15.4` is a float and `15.10` becomes `15.1` (data loss). The
loader coerces ints (safe), accepts strings, and **rejects floats** with a message telling the user
to quote the id. The example config quotes every id.

**No PyYAML dependency.** To honour the "stdlib-only, no venv" promise, the lib prefers PyYAML if
importable but falls back to a small built-in indentation parser (`_stdlib_yaml_load`) that handles
exactly the subset these configs and the `IMPL-EXEC` block use (block maps/seqs, inline flow
lists/maps, quoted/bare scalars, bool/int/float/null, comments).

---

## 5. Task selection

`task_pipeline_lib.select_tasks` is pure and unit-tested. Precedence `list > range > all`; `[x]`
tasks always skipped; parent ids expand to descendants. `tasks.optional` filters optional (`[ ]*`)
tasks **only in the `all` mode** — explicit `range`/`list` selections include optional tasks inside
them, because naming them is deliberate. A `list` runs in the exact order given (the tool does not
reorder for dependencies — that's the author's call). See the README table for the full matrix.

`unit_tests: false` takes precedence over the selection: the agent skips test-only tasks and the
spine skips the coverage gate.

---

## 6. Gates

- **Preflight (script):** config valid; GitLab token present; Jira subtask resolves; source/spec
  branches exist; `tasks.md` present + parseable; selection non-empty and all ids known.
- **Pre-push (agent runs the scripts):** `compliance_gate.py` always; `coverage_gate.py` when
  `unit_tests: true`. Both must exit 0 before push.
- **Post-hoc (spine re-runs the scripts):** independent re-verification of coverage + compliance
  against the clone. A scripted grep/coverage-diff an LLM self-audit can't fudge.

`coverage_gate.py` and `compliance_gate.py` are copied verbatim from the bug-fixer. For greenfield
files the coverage gate's "no regression" is trivially met (baseline 0) and "every added line
covered" becomes full new-code coverage — exactly the standards' new-code bar.

---

## 7. Model selection

`kiro-cli chat` binds one model per agent in its JSON, but supports `--model` to override per
invocation. The spine resolves the config's `model` alias to an exact id
(`task_pipeline_lib.resolve_model`) and passes `--model <id>`. A name→id mapper keeps the config
stable (`model: opus`) as the exact id evolves; unknown/future ids pass through unchanged. Default
is Opus (greenfield task implementation benefits from the stronger model).

---

## 8. Multi-MR-per-subtask

One run = one branch + one task selection + one MR (or push). Multiple MRs for a subtask = multiple
runs with different `branch_name` + selection. Each run checks off its own tasks in `tasks.md` and
opens its own MR. (If two runs on different branches both edit `tasks.md`, the check-offs live on
their respective branches — expected; a human reconciles at merge.)

---

## 9. Open items / future

- `spec.location: local` can update the local `tasks.md` for tracking but can't commit it (it's not
  in the repo); repo-located specs are the primary path.
- Cross-task dependency ordering for a custom `list` is the author's responsibility; the tool obeys
  the given order and warns in the README rather than reordering.
- MR "depends on" between multi-run MRs of one subtask is a human concern today (no MR-dependency
  API exposed by the MCP), same as the bug-fixer's package flow.
