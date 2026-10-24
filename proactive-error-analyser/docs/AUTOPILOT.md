# Autopilot — end-to-end error → ticket → fix → MR

The **autopilot** chains three dev-toolbox tools into one background-runnable
pipeline, driven from the Proactive Error Analyser:

```
proactive-error-analyser  →  p1-ticket-builder (MCP)  →  jira-gitlab-bugfix-agents-v2
   detect + classify           create P1 Jira ticket        devise fix + open GitLab MR
   (logs streamed to disk)      (KIRO-EXEC, no solution)     (autonomy=auto-mr: push, no merge)
```

Each underlying tool is **preserved**. `run-live.ts` only gained (a) an exported
entrypoint and (b) on-disk log streaming; the P1 MCP server and the bugfix agent
are unmodified and invoked through their public interfaces.

---

## The chain, step by step

### 1. Detect + classify (unchanged analysis)
`run-autopilot.ts` calls the existing live analysis (`runLiveAnalysis` in
`run-live.ts`). Phases 1–5 run exactly as before (CloudWatch → pinpoint →
fetch logs → classify → report to `output/`).

### 2. Logs: streamed to disk, retained (not in memory)
During Phase 3 the fetched **raw ERROR logs are streamed to disk** as they
arrive, one JSON object per line:

```
proactive-error-analyser/logs/<runId>/<service>__<endpoint>.log.jsonl
proactive-error-analyser/logs/<runId>/manifest.json   ← maps report ↔ log files
```

- The full evidence lands on disk **as it is fetched** via `fs.createWriteStream`
  (append), so memory stays bounded — only a small deduped, capped set
  (`maxEntries`, default 20 per endpoint) is held in memory for classification.
- The on-disk logs are **kept for future context** (they are *not* deleted).
  `logs/` is gitignored.

> Note on source: the analyser reads logs from the **workflow-tools-service
> `/application-logs/search` API** (not a literal Elasticsearch/S3 client). The
> "download + save" requirement is honoured by persisting those API results to
> disk with a stable path + name. If a true ES/S3 source is wired later, only
> the fetch function changes — the sink stays the same.

### 3. Build the P1 ticket input (no human solution)
For each **critical/high**, non-`unclassified` issue (capped by `--max-tickets`),
`buildP1InputFromIssue()` (`src/autopilot/p1-input.ts`) produces the exact input
object for the `build_p1_ticket` MCP tool.

Key design points:
- **`proposedSolution` is a required field** in `build_p1_ticket` and its
  `**Proposed Solution:**` section is always rendered — there is no "solutionless"
  mode. So the autopilot fills it with an explicit **sentinel**
  (`NO_HUMAN_SOLUTION_SENTINEL`) that tells the agent *not* to treat it as a spec.
- The KIRO-EXEC block emitted by `build_p1_ticket` **has no `spec_source` field**.
  The bugfix agent's fixer therefore defaults `spec_source` to `analyzer` — it
  runs its own Opus analyzer, derives `findings.md`, and only proceeds when
  `alignment == aligned`. Net effect: **the ticket carries no human fix; the
  agent devises and implements its own.**
- `kiroExec.autonomy = 'auto-mr'` → the fixer **creates + pushes an MR, never
  merges**. `base_branch`/`target_branch` default to `develop`.

Each issue is written to `autopilot/<runId>/jobs/<issueId>.job.json`, and a
`autopilot/<runId>/plan.json` summarises the run.

### 4. Create ticket + trigger fix (out-of-process, headless)
In `--run` mode, `run-autopilot.ts` shells `bin/run-autopilot.sh <jobFile>` per
job. That driver:

1. Uses **`kiro-cli`** (which has the MCP bridge + macOS keychain) to
   call `build_p1_ticket`, forward `jira_create_issue_args` to `jira_create_issue`,
   and echo `CREATED_ISSUE=<KEY>`.
2. Runs `jira-gitlab-bugfix-agents-v2/bin/run-bugfix-pipeline.sh <KEY>
   --scripts <dir> --prefixes DT` headless. The agent reads the ticket's
   KIRO-EXEC block, runs its analyzer, implements the fix, and opens the MR.

Secrets are read from env / keychain by the bugfix launcher itself
(`gitlab-pat`, `atlassian-email`, `atlassian-api-token`, `jira-base-url`).
`KIRO_API_KEY` must be set for the agents to run headless.

---

## Running it

### Dry-run (safe default — no tickets, no MRs)
```bash
cd proactive-error-analyser
AWS_REGION=eu-west-1 npx tsx run-autopilot.ts --emit-only --days 1 --threshold 20
# → writes logs/<runId>/, output/live-analysis-*, and autopilot/<runId>/{jobs,plan.json}
```

### Full autopilot
```bash
cd proactive-error-analyser
AWS_REGION=eu-west-1 KIRO_API_KEY=<key> \
  npx tsx run-autopilot.ts --run --days 1 --threshold 20 --prefixes DT
```

### Flags
| Flag | Meaning | Default |
|------|---------|---------|
| `--run` / `--emit-only` | execute vs dry-run | `--emit-only` |
| `--include-unclassified` | also file tickets for unclassified errors (bug fixer investigates from scratch) | off |
| `--severity C,H` | severities to act on | `critical,high` |
| `--max-tickets N` | cap tickets per run | `5` |
| `--project KEY` | Jira project | `DT` |
| `--autonomy MODE` | `propose`\|`auto-mr`\|`auto-merge` | `auto-mr` |
| `--base-branch NAME` | fix base/target branch | `develop` |
| `--prefixes DT,VP` | passed to bugfix pipeline | `DT` |
| `--days`/`--threshold`/`--services`/`--start`/`--end` | passed to `run-live` | see run-live |

### Background / scheduled
`run-autopilot.ts` takes no interactive input in `--run` mode (given
`KIRO_API_KEY`), so it runs from any background process, cron, or the KiroCrew
`cron_add` scheduler. Example (KiroCrew cron `command`):
```
cd .../proactive-error-analyser && AWS_REGION=eu-west-1 KIRO_API_KEY=$KIRO_API_KEY \
  npx tsx run-autopilot.ts --run --days 1 --threshold 20 --prefixes DT
```

---

## Orchestration option: pure `kiro-cli` (no run-autopilot.ts)

The `run-autopilot.ts` orchestrator above is the primary path. The **same chain
is also achievable directly through `kiro-cli`** as an alternative — useful for
ad-hoc single-issue runs or when you want a human in the loop. Because `kiro-cli`
already bridges the MCP tools and holds the keychain secrets, one agent turn can
drive the whole sequence:

```bash
# 1. Analyse (writes the report + logs to disk)
AWS_REGION=eu-west-1 npx tsx run-live.ts --days 1 --threshold 20

# 2. Hand the report to kiro-cli and let it drive the MCP + bugfix chain:
kiro-cli chat --agent default --no-interactive \
  --trust-tools=build_p1_ticket,jira_create_issue \
  "Read proactive-error-analyser/output/live-analysis-<ts>.json. For each critical/high
   issue: call build_p1_ticket with a sentinel proposedSolution (no human fix) and
   kiroExec.autonomy=auto-mr, base_branch=develop; forward jira_create_issue_args to
   jira_create_issue; then run jira-gitlab-bugfix-agents-v2/bin/run-bugfix-pipeline.sh
   <KEY> --prefixes DT for each created ticket."
```

This is functionally equivalent to `run-autopilot.ts --run`; the TypeScript
orchestrator just makes it deterministic, cappable, and background-safe.

---

## Prerequisites (one-time setup)

1. **AWS profile** for the prod account, region `eu-west-1`. The CloudWatch
   module reads a named profile (env `AWS_PROFILE`, else a hardcoded fallback),
   so pass your own: `AWS_PROFILE=<you> AWS_REGION=eu-west-1 ...`. Verify with
   `AWS_PROFILE=<you> aws sts get-caller-identity --region eu-west-1`.
2. **Log tokens (AT/RT)** so Phase 3 can fetch logs (else everything stays
   `unclassified`). Put `AT_TOKEN` / `RT_TOKEN` in `proactive-error-analyser/.env`
   (copy from a DFG portal: DevTools → Application → Cookies), or point
   `LOG_AUTH_ENV_PATH` at an existing `workflow-mcp-server/.env`. Tokens are
   short-lived — a `HTTP 500` from the log API in Phase 3 usually means they
   expired (the tool now prints this explicitly).
3. **Sibling deps**: `cd cloudwatch-metrics-reports && npm install --omit=dev`
   (its `.mjs` modules are imported by `run-live.ts`).
4. **Bug-fixer secrets** (only needed for `--run`, read from macOS keychain by
   the bugfix launcher): `gitlab-pat`, `atlassian-email`, `atlassian-api-token`,
   `jira-base-url`. Optional `kiro-api-key` → runs the fixer **headless**; without
   it the fixer runs **interactive** and may prompt for tool approvals.

## Deduplication (no duplicate tickets)

Every ticket carries a stable fingerprint label
`autopilot-<sha1(service::endpoint)[:8]>`. Before creating, the driver runs a
`jira_search` for that label with `statusCategory != Done`. On a match it prints
`EXISTING_ISSUE=<KEY>`, **skips creation**, and still proceeds to the bug fixer on
the existing ticket. So re-running the autopilot on a recurring error re-uses the
open ticket instead of filing a duplicate.

## Audit trail (`results.jsonl`)

Each run appends one JSON line per job to `autopilot/<runId>/results.jsonl`:
`{ ts, status, issueKey, service, endpoint, severity, category, fingerprint, note }`
where `status` ∈ `ticket_created | duplicate_skipped | bugfix_completed |
bugfix_stopped`. This is the durable record of what a run filed — the ticket key
survives even if the terminal output is lost. Inspect with
`cat autopilot/*/results.jsonl`.

## Classifier patterns

`run-live.ts` registers these patterns (highest priority first); the first match
≥ its confidence threshold wins, else `unclassified`:

| Pattern | Category | Notes |
|---|---|---|
| NullReference (90) | `null_reference` | crash on null/undefined |
| StatusCodeMismatch | `status_code_mismatch` | |
| UpstreamDependency (85) | `upstream_dependency` | **socket hang up / ECONNRESET → traces the ROOT service** (via outbound URL, `prevService`, url path) and routes the ticket there (`primary_repos`, `root:<svc>` label) |
| Timeout (80) | `timeout` | |
| AuthError (75) | `configuration` | `INVALID_TOKEN`, token-decode/refresh, 401 |
| ValidationError (70) | `validation_error` | `X is required`, `DFGError`, `*Exception` |
| DDBThrottling / PathConstruction | … | |

`validation_error`, `upstream_dependency`, and `configuration` are floored to
**high** severity when `errorCount > 5`, so they become actionable.

## Verified behavior (what "correct" looks like)

- The bug fixer runs its own analyzer and **ignores the ticket's category
  hypothesis** — it re-derives the root cause from source. If it cannot pin a
  confident, localized fix in the mapped repo (e.g. the real cause is in a shared
  package, or it's an operational issue), it writes `alignment: mismatch` and
  **halts without opening an MR**. A halt is a correct, safe outcome, not a
  failure — it prevents an unsafe auto-fix in the wrong place.
- Ticket creation uses the `mcp-atlassian` / `jira_create_issue` credential; the
  analyzer's mismatch **comment** uses the agent's own Atlassian token, which may
  lack Jira **write** scope (401). If so, the comment text is preserved in
  `/tmp/kiro-bugfix/<KEY>/findings.md` and must be posted manually until the
  token is granted write scope.

---

## What was changed vs preserved

- **Changed (analyser only):** `run-live.ts` streams raw logs to disk and exports
  `runLiveAnalysis`; new classifier patterns (`validation-error`,
  `upstream-dependency`, `auth-error`) + `diagnosis/root-service-tracer.ts`;
  new `src/autopilot/p1-input.ts`, `run-autopilot.ts`, `bin/run-autopilot.sh`
  (dedup + `results.jsonl`); `severity.ts` floors; `tsconfig.json` include +
  `.gitignore` entries; unit tests.
- **Changed (bug fixer, one-line defect fix):**
  `jira-gitlab-bugfix-agents-v2/bin/run-bugfix-pipeline.sh` — guarded an empty
  bash array under `set -u` (`${arr[@]+"${arr[@]}"}`) so it runs without
  `KIRO_API_KEY`. Behavior preserved.
- **Preserved (unmodified):** `mcp/p1-ticket-builder` and the
  `jira-gitlab-bugfix-agents-v2` scripts/agents are used only through their
  existing public interfaces (`build_p1_ticket` / `jira_create_issue`, and
  `run-bugfix-pipeline.sh`).
