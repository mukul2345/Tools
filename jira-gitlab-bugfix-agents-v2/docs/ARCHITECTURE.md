# Jira → GitLab Agentic Bug-Fixer — Architecture & Decisions

Living design doc. Captures what exists today, why, and what's planned next. Update as we go.

---

## 1. Goal

Given a Jira bug ticket, an agent (running on Kiro CLI) reads it, independently analyzes the
relevant GitLab code, makes the fix on a local clone, runs tests + coverage, and raises a merge
request that complies with team process — with human gates where it matters.

Tools in play: Jira (Atlassian Rovo MCP), GitLab (@zereight/mcp-gitlab MCP), Kiro CLI/IDE,
internal workflow-mcp-server, CloudWatch MCP, macOS.

---

## 2. Current state (built & validated)

### Files and where they live

| File | Location | Purpose |
| --- | --- | --- |
| `jira-bug-fixer.json` | `~/.kiro/agents/` | The Kiro custom agent (the fixer). |
| `jira-bug-fixer-prompt.md` | `~/.kiro/agents/` | The agent's run-loop system prompt (`file://` in agent). |
| `jira-bug-template-kiro.md` | `~/.kiro/agents/` | Ticket template + `KIRO-EXEC` block spec (agent resource). |
| `component-repo-mapping-kiro.md` | `~/.kiro/agents/` | Jira Component → GitLab repo map (agent resource). |
| `merge-request-process-vpt.md` | `~/.kiro/agents/` | VPT MR process (agent resource). |
| `coding-guideline.md` | `~/.kiro/steering/` | Coding standards steering file (`fileMatch **/*.ts`). |
| `unit-test-guidelines.md` | `~/.kiro/steering/` | Unit-test standards steering (`fileMatch **/*.test.ts`). |
| `kiro-mcp.fixed.json` | `~/.kiro/settings/mcp.json` | Hardened MCP config (Jira + GitLab enabled, no inline secrets). |
| `run-bug-fixer-interactive.sh` | `~/my-projects/jira-bug-fixer/` | Interactive runner (no API key needed). |
| `run-bug-fixer.sh` | `~/my-projects/jira-bug-fixer/` | Headless runner (needs `KIRO_API_KEY`, org-gated). |
| `SETUP.md` | reference | Step-by-step setup. |

### The run loop (current single agent)

1. Read + parse ticket (`getJiraIssue`); locate & parse the `KIRO-EXEC` YAML block.
2. Resolve repos from Components via the mapping (code vs. area; halt on unknown).
3. Clone into `/tmp/kiro-bugfix/<KEY>/<repo>` (token in clone URL), `pnpm install`, branch.
4. Make the fix per coding guidelines; add tests per unit-test guidelines.
5. Verify: run tests; coverage is **best-effort / no-regression** (baseline vs. current per
   changed file), not a hard threshold gate.
6. Autonomy gate: `propose` (post diff, no MR) | `auto-mr` (open MR) | `auto-merge` (never merge).
7. Commit → `git push -u origin <branch>` → `create_merge_request` (Jira ID in title, VPT
   checklist in description, reviewers resolved via `get_users`).
8. Report back on Jira (`addCommentToJiraIssue`).
9. Clean up the clone on success; keep it on STOP/failure for inspection.

### Key decisions already made

- **Interactive mode is the default runner** — org has API-key generation disabled, so headless
  is unavailable for now; interactive uses the normal login session.
- **Autonomy defaults to `propose`**; graduate tickets to `auto-mr` once trusted. Never auto-merge.
- **Coverage is best-effort/no-regression** (legacy code rarely meets absolute thresholds);
  before/after numbers go in the MR description so reviewers can see any regression.
- **Reviewers assigned via `get_users`** (pre-approved read tool); unresolved names fall back to
  being listed in the description, never a stop.
- **Steering vs. resources split**: file-scoped standards (coding, unit-test) → steering files;
  workflow/action-scoped docs (MR process, ticket template, repo map) → agent resources. Custom
  agents don't auto-inherit steering, so steering files are referenced explicitly in `resources`.
- **Secrets**: GitLab PAT + Kiro API key come from the macOS keychain via the runner; never inline.
  (The originally-committed PAT must be revoked.)

### Notable bugs found & fixed along the way

- Shell `deniedCommands` pattern `.*-f.*` blocked normal pushes because branch names contain
  `-fix`. Rewritten to only catch real `--force`/`-f`, self-tested.
- `resources` `file://./…` resolved against CWD (the temp clone), not the agent dir → switched to
  absolute paths.
- Agent cloned to a fixed `/tmp/<repo>` and never cleaned up, because shell calls don't share a
  CWD → deterministic per-issue path + explicit cleanup step.

---

## 3. Planned next: two-agent analyze-then-fix flow

**Decision: two agents, orchestrated by a runner script.** Driver = Kiro binds one `model` per
agent and headless can't switch mid-run, so Opus-analysis + Sonnet-fix requires two configs.

### Agent 1 — `jira-bug-analyzer` (model: Opus 4.8), READ-ONLY

- Treats the Jira "Proposed Solution" as an **unverified hypothesis**, not ground truth.
- Does **factual** analysis only — find all references/call-sites of the buggy symbol, trace data
  flow and sibling paths; no reasoning purely from the English description.
- Writes its detailed evidence to `/tmp/kiro-bugfix/<KEY>/analysis.md`.
- Compares its independent root cause against the ticket's proposal and **always writes
  `/tmp/kiro-bugfix/<KEY>/findings.md`** with a `FINDINGS-EXEC` block (`alignment`,
  `package_change`, `feature_flag`) plus tables and prose:
  - **Aligned** (`alignment: aligned`) → `findings.md` is the fixer's spec; the spine auto-proceeds.
  - **Mismatch** (`alignment: mismatch`) → also posts a Jira comment with evidence and **HALTS**.

### Agent 2 — `jira-bug-fixer` (model: Sonnet 4.6)

- Consumes `findings.md` as its spec (proceeds only when `alignment: aligned`) and runs the
  install/fix/test/coverage/MR loop. Writes `implementation.md` (an `IMPL-EXEC` block + coverage
  table + MR blocks + diff) on every exit for the spine to read.

### Orchestration (deterministic spine — `scripts/run_pipeline.py`)

A Python driver — **not an LLM** — owns the sequence: gather → resolve → analyze → gate → fix →
coverage → compliance → report. It calls the LLM at only the analyze and fix nodes (each a plain
`kiro-cli` subprocess), reads `FINDINGS-EXEC.alignment` for the gate, and runs the coverage and
compliance checks as scripts. The former Haiku orchestrator that did this via Kiro subagents was
retired — it performed zero reasoning (see `ORCHESTRATION-AUDIT.md`).

Handoff = a file on disk + a gate. Auditable, model-agnostic, deterministic — and now the control
plane is code, so a re-run resumes at the first missing step rather than re-paying for it.

### Analyzer input: ticket-history gather script (decided — feasible)

Before a code-fix ticket exists there's usually an upstream ops/external ticket. The analyzer
must understand the whole history, not just the code-fix ticket. To do this **without burning
Kiro credits**, a deterministic **gather script** (run by the analyzer via one shell call)
collects everything and writes a single file the analyzer reads.

- **Jira access — NOT via MCP.** The script calls the **Jira Cloud REST API v3 directly using an
  API token + Basic auth** (`ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN`, from keychain). Atlassian
  recommends Basic-auth API tokens specifically for scripts/bots. This is independent of the
  MCP's OAuth. (Mirrors GitLab: agent → MCP, script/git → token.)
- **Traversal (BFS, deduped, depth/count-capped):**
  - `GET /issue/{key}?fields=summary,status,issuetype,created,updated,description,issuelinks,comment`
  - `GET /issue/{key}/comment?startAt=…` (paginate all comments)
  - `GET /issue/{key}/remotelink`
  - Follow `issuelinks` recursively; also regex `[A-Z][A-Z0-9]+-\d+` in descriptions/comments to
    catch keys mentioned but not formally linked; validate each candidate (drop 404s), optionally
    restrict to known project prefixes.
- **Repo references** (gitlab.com/`git@` URLs or names matching the component→repo map) are
  recorded → analyzer clones them read-only for context.
- **Output:** one timestamp-sorted `ticket-history.md` (timeline: ts · ticket · author ·
  kind · text) + a JSON sidecar (tickets visited, repos discovered).
- **Boundary:** script is **read-only**. All Jira writes (halt comment, report) stay in the agent
  via MCP — one auditable write path.
- **Caveats to build in:** flatten **ADF** (v3 rich-text JSON) to text (or `renderedFields`);
  validate regex ticket keys to avoid false positives; visited-set + max-depth/count caps.

### Fixer output: developer verification artifacts (decided)

Goal: give the developer everything to verify the fix — scenarios (bugfix, regression,
feature-flag on/off), which API + payload to hit, and simple assertions — **without burning LLM
tokens on document generation.** Same LLM-emits-compact-file + script-renders pattern as the Jira
gather-script.

- **Analyzer supplies the map** (locked): entry points / affected routes (upward call-graph trace
  from the changed symbol → controller), regression call-sites, and the guarding feature-flag
  name go into `findings.md`.
- **Fixer emits a compact "verification manifest"** (its final step — it already holds the diff,
  brief, and mined payloads, so this is cheap; **no third agent for v1**). Machine-only
  YAML/JSON: per-scenario `kind` (bugfix|regression|feature_flag), preconditions (flag state,
  seed data), request (method/path/body or fixture ref), V1 simple assertions, evidence +
  confidence tag, and a gaps note. Dynamic values declared once as variables (baseUrl, authToken,
  seed IDs). Optional `capture` (e.g. `$.id → caseId`) for response chaining.
- **Render script** (`build-verification-artifacts`) reads the manifest and generates:
  - `verification/verification-guide.md` — human table grouped by kind; "evidence source" and
    "gaps" columns enforced by format (gaps are labeled, never hidden).
  - `verification/openapi.yaml` — importable contract (paths, bodies, `servers` vars).
  - `verification/postman_collection.json` + `postman_environment.json` — where dynamic variables,
    response-chaining, and the V1 assertions live (OpenAPI can't express assertions/chaining).
  - stats block (counts per kind, #gaps) for the MR description.
- **Optional** — only runs when `manual_testing_artifacts: true` in the `KIRO-EXEC` block. Default off.
- **Location:** artifacts committed to the branch under `verification/`; MR description carries
  only stats + a link; optional short Jira comment pointing to it.
- **V1 scope:** simple (API response-level) assertions; audit-trail/DB SQL assertions via
  workflow-mcp-server deferred to a later version.

### Fixer input: pluggable spec source (decided — bake in now)

The fixer already consumes a "spec/brief"; only its *source* varies. Generalize via a
`spec_source` field in `KIRO-EXEC`:

- `analyzer` (default) → reads `findings.md`, proceeding only on `alignment: aligned` (two-agent flow).
- `jira` → reads the ticket's Proposed Solution directly (analyzer bypass).
- `kiro_spec` → developer-authored Kiro spec (requirements/design/tasks) on a branch, via
  `spec_branch` + `spec_path`. Analyzer + mismatch-halt are skipped; fixer checks out the spec
  branch and treats the spec files as its brief. Delivers the "run only the fixer" case.

Wire the field + branch/path plumbing now; the `kiro_spec` reader can follow — it's a thin slot.

### Story/feature development: SEPARATE sibling agent (deferred, NOT a fixer mode)

Using the same agent for full story development is a **new requirement**, not a fixer mode. The
bug-fixer's guardrails (minimal diff, one-bug-per-run, mirror existing behavior, verify a proposed
fix) actively conflict with greenfield feature work (multi-file, new APIs/migrations, execute a
`tasks.md` checklist). Do **not** overload one agent to do both.

However the substructure is shared: clone → install → implement-from-spec → tests/coverage → MR →
verification artifacts. Plan a future sibling agent (`story-implementer`, likely stronger model)
that reuses those shared steps with its own prompt/guardrails. Action now: keep the fixer's
spec-ingestion and shared steps reusable so the sibling is cheap later. Parked, not built.

### Locked settings

- **Models** (confirmed via `kiro-cli` model list):
  - Analyzer → `claude-opus-4.8` (2.20x credits) — thorough factual analysis.
  - Fixer → `claude-sonnet-4.6` (1.30x credits) — implementation. *(Set in `jira-bug-fixer.json`.)*
  - Non-LLM scripts (gather, render) cost 0 credits.
- **Script language = Python.** Host = macOS on Apple silicon (M*). Preference: **stdlib-only
  scripts** (`urllib`, `json`, `re`) so **no venv / pip is needed** — sidesteps the M-series venv
  concern entirely. OpenAPI/Postman/collection files are just JSON, which stdlib emits. If a
  dependency ever becomes necessary, the runner creates a local `.venv` and installs there
  (never global); document that in SETUP.
- **KIRO-EXEC verification toggle field = `manual_testing_artifacts`** (bool, default off). Gates
  the fixer's manifest emission + render script.
- **Strict enforcement (fixer):** `coding-guideline.md`, `unit-test-guidelines.md`, and
  `merge-request-process-vpt.md` are **hard gates**, not advisory. Prompt Step 5.5 verifies
  mechanically (ESLint/Prettier zero-error + no new `eslint-disable`; grep test files for
  `jest.mock(`/`jest.fn(`/`: any`/`: unknown`/logger assertions; MR checklist completeness) and
  **STOPs** rather than opening a non-compliant MR.

### Build status — DONE (pipeline built & validated)

New components (all validated: python compiles, JSON/bash parse, render-script smoke-tested):

| File | Location | Role |
| --- | --- | --- |
| `jira_gather.py` | `~/my-projects/jira-bug-fixer/scripts/` | Jira history ETL (stdlib, Basic-auth token). |
| `build_verification_artifacts.py` | `~/my-projects/jira-bug-fixer/scripts/` | Renders guide/OpenAPI/Postman from manifest. |
| `jira-bug-analyzer.json` | `~/.kiro/agents/` | Analyzer agent (Opus, read-only). |
| `jira-bug-analyzer-prompt.md` | `~/.kiro/agents/` | Analyzer run loop. |
| `run-bugfix-pipeline.sh` | `~/my-projects/jira-bug-fixer/` | Thin launcher: loads secrets → execs `run_pipeline.py`. |
| `run_pipeline.py` | `~/my-projects/jira-bug-fixer/scripts/` | Deterministic spine: gather → resolve → analyze → gate → fix → coverage → compliance → report. |
| `pipeline_lib.py` | `~/my-projects/jira-bug-fixer/scripts/` | Parsers: KIRO-EXEC/FINDINGS-EXEC/IMPL-EXEC, component map, repo resolution, gate readers. |
| `coverage_gate.py` / `compliance_gate.py` | `~/my-projects/jira-bug-fixer/scripts/` | Scripted §5 coverage-diff and §5.5 standards checks. |
| `jira-bug-fixer.json` / `-prompt.md` | `~/.kiro/agents/` | Fixer, with `spec_source` seam + manifest step + model. |
| `jira-bug-template-kiro.md` | `~/.kiro/agents/` | Template, with `spec_source`/`spec_branch`/`spec_path`/`manual_testing_artifacts`. |

New secrets (keychain): `atlassian-email`, `atlassian-api-token`, `jira-base-url` (plus existing
`gitlab-pat`). `KIRO_API_KEY` optional (runs the agents headless).

Pipeline data flow (all under `/tmp/kiro-bugfix/<KEY>/`):
`ticket-history.md/.json` + `ticket.md` (gather) → repo resolution (script) → `analysis.md` +
`findings.md` (analyzer, or halt) → fixer implements + writes `implementation.md` → coverage +
compliance gates (scripts) → `<repo>/verification/*` (optional, via render script) → MR.

### Orchestration: deterministic spine (replaces the retired Kiro-subagent orchestrator)

Earlier design chained two `kiro-cli chat` sessions (human had to exit the analyzer before the
fixer ran), then a thin **Haiku orchestrator** ran them as Kiro subagents in one session to remove
that manual hand-off. The audit (`ORCHESTRATION-AUDIT.md`) showed the orchestrator did **zero
reasoning** — every step was deterministic control flow — so it was retired in favor of a Python
spine (`scripts/run_pipeline.py`):

- The spine owns the sequence and calls the analyzer and fixer as **ordinary `kiro-cli` agent
  subprocesses** (no subagent feature required, so no Kiro-version floor).
- The per-agent model split is unchanged: analyzer = Opus 4.8, fixer = Sonnet 4.6.
- The gate is a file read in code: `FINDINGS-EXEC.alignment == aligned` → run the fixer, else halt.
- Steps checkpoint to files, so a failed/halted run resumes at the first missing output instead of
  re-paying for completed work; `--force` / `--from <step>` control this.

Web agents (app.kiro.dev) considered for unattended/scheduled cloud runs but deferred: preview +
US-only, and it can't see the local `workflow-mcp-server`/scripts/keychain without a cloud port.

### Multi-repo subtasks + shared-package flow (added)

**Multi-repo → Jira subtasks.** When a fix spans multiple repos, the fixer creates a Jira **subtask
per repo** under the bug (`createJiraIssue`, `issuetype: Sub-task`, `parent: <bug>`), title prefixed
`[<repo>]`, inheriting the parent's components/priority/labels/fixVersions/assignee. Each repo's MR
title uses **its subtask key**, not the parent bug key. `createJiraIssue` +
`getJiraProjectIssueTypesMetadata` added to fixer `allowedTools` and mcp autoApprove.

**Shared packages (private npm registry).** Mapping now has a `packages` table (`@dfg/*` → repo →
registry id, `base_branch: master`). When the fix is to a published type/contract, the fixer:
clones the package repo, forks a feature branch **from master**, edits, **bumps version + updates
CHANGELOG**, `pnpm build` + `pnpm link --global`; then in each consuming repo `pnpm link --global
@dfg/<pkg>` and bumps the dependency version so local build/tests pass. Package MR targets master
(publishes on merge); consuming MRs get a `⛔ Depends on package MR <url>` line and must merge after
the package publishes. Package repos may coincide with component repos — the distinction is whether
the change is to the published contract (package flow) vs. the service's runtime code (component
flow).

### Open items

- MR-level "depends on" is expressed as a description marker (GitLab MR dependency API isn't exposed
  by the MCP); a human enforces merge order. Revisit if the MCP gains `depends_on`.
- Verify exact MCP tool names for the analyzer/fixer in a live `/tools` check.
- Populate `default_reviewers` with real GitLab usernames.
- Story-implementer sibling agent — deferred (design captured above).

---

## 4. Parking lot / future

- Headless + scheduled/webhook triggering once org enables API keys.
- Pre-filling `default_reviewers` with real GitLab usernames from the VPT service-owner table.
- Optional: `merge-request-process-vpt.md` as a `manual`-inclusion steering file for IDE use.
