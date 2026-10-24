# Proactive Error Analyser

Automated production-error diagnosis. It pulls API error metrics from CloudWatch
(`DFG-Observability`), pinpoints the exact error time windows, fetches the
matching application logs, classifies each error against known patterns, and
produces a report **grouped by service** (with each issue tagged by its error
category).

- Full spec (requirements/design/tasks) lives in [`spec/`](./spec).
- Reports are written to [`output/`](./output) as `.md` and `.json`.

## Prerequisites

1. **Node.js 18+**
2. **Dependencies installed:**
   ```bash
   pnpm install   # or: npm install
   ```
3. **AWS credentials** for account `891377067284`, region `eu-west-1` (read-only
   CloudWatch access is enough). Verify:
   ```bash
   aws sts get-caller-identity --region eu-west-1
   ```
   The tool reads the standard AWS credential chain (env vars, `~/.aws`, SSO).
4. **Workflow-tools-service auth tokens (AT/RT)** — required for log fetching
   (Phase 3). Without them the run still works but every issue stays
   `unclassified` (no log evidence to pattern-match). See below.

## Setup: log auth (AT / RT tokens + URL)

The live run reads prod application logs via the workflow-tools-service log API,
which needs `at`/`rt` session tokens and the service base URL.

**Recommended: reuse the workflow-mcp-server config (no setup needed).**
The tool automatically reads `AT_TOKEN`, `RT_TOKEN`, and `WORKFLOW_TOOLS_URL`
from the workflow-mcp-server's `.env`:

```
dataflow-repo/dev-toolbox/mcp/workflow-mcp-server/.env
```

This is the same config the MCP server uses, so if your MCP server works, log
fetching here works too — nothing extra to configure.

**Alternative: override locally.** Create a `.env` in this folder or export
env vars:

```bash
cd proactive-error-analyser
cp .env.example .env   # then edit
```
```
AT_TOKEN=<your at token>
RT_TOKEN=<your rt token>
WORKFLOW_TOOLS_URL=<optional base url>
```

**How to refresh tokens:** log in to any DFG portal → DevTools → Application →
Cookies → copy `at` and `rt`. They're short-lived; refresh if Phase 3 starts
returning empty logs. `.env` is gitignored, so tokens are never committed.

> Resolution order (first non-empty wins, per field):
> 1. Env vars `AT_TOKEN` / `RT_TOKEN` / `WORKFLOW_TOOLS_URL`
> 2. `$LOG_AUTH_ENV_PATH` (explicit `.env` path)
> 3. `dev-toolbox/mcp/workflow-mcp-server/.env`  ← canonical, used automatically
> 4. `proactive-error-analyser/.env`

## Running

### Live production run

```bash
# last 7 days, endpoints with > 10 errors, all services
AWS_REGION=eu-west-1 npx tsx run-live.ts --days 7 --threshold 10

# last 1 day, only specific services
AWS_REGION=eu-west-1 npx tsx run-live.ts --days 1 --threshold 5 \
  --services document-management-service,verification-request

# explicit date range
AWS_REGION=eu-west-1 npx tsx run-live.ts \
  --start 2026-07-01 --end 2026-07-08 --threshold 10
```

**Flags:**
| Flag | Meaning | Default |
|------|---------|---------|
| `--days N` | Look back N days from now | 7 |
| `--threshold N` | Min error count for an endpoint to be investigated | 10 |
| `--services a,b,c` | Comma-separated service list | all 11 services |
| `--start YYYY-MM-DD` | Explicit window start (overrides `--days`) | — |
| `--end YYYY-MM-DD` | Explicit window end | now |

If nothing exceeds the threshold, it prints **"All clear!"** and exits without
writing a report.

### Demo run (mock data, no AWS/tokens)

```bash
npx tsx run-demo.ts
```

Useful to see the report format without hitting prod.

## Output

Each live run writes a timestamped pair to `output/`:

- `live-analysis-<timestamp>.md`   — human-readable, **grouped by service**
- `live-analysis-<timestamp>.json` — machine-readable (`serviceGroups` + flat `issues`)

The Markdown report contains:
1. **Summary** — totals, severity counts, top categories, and a **By Service** table
2. **Issues by Service** — one `📦 <service>` section per service with a rollup
   header (errors, issue count, severity breakdown, categories), then its issues
   ordered by severity, each tagged with its category, e.g. `[status_code_mismatch]`
3. **Metadata** — analysis id, duration, data sources, errors encountered

## Pipeline (what a live run does)

1. **Phase 1** — CloudWatch: error counts (API_COUNT, statusCode=500) per endpoint
2. **Phase 2** — pinpoint exact 5-minute error windows from metric timestamps
3. **Phase 3** — fetch matching ERROR logs for those windows (needs AT/RT tokens)
4. **Phase 4** — correlate + classify against patterns (status_code_mismatch,
   null_reference, ddb_throttling, path_construction, timeout, …)
5. **Phase 5** — diagnose, group by service, and write the report

## Autopilot (error → ticket → fix → MR)

An opt-in **autopilot** chains this analyser to the `p1-ticket-builder` MCP and
`jira-gitlab-bugfix-agents-v2` so a run can auto-file P1 tickets and open fix MRs:

```bash
# Dry-run: analyse + emit P1 job files, no tickets/MRs
AWS_REGION=eu-west-1 npx tsx run-autopilot.ts --emit-only --days 1 --threshold 20

# Full: analyse → create tickets → open MRs (headless; needs KIRO_API_KEY)
AWS_REGION=eu-west-1 KIRO_API_KEY=<key> npx tsx run-autopilot.ts --run --days 1 --threshold 20
```

Tickets are created with a **sentinel proposed-solution** (no human fix) so the
bugfix agent devises its own; MRs are opened with `autonomy=auto-mr` (push, never
merge). Raw logs are streamed to disk under `logs/<runId>/` and retained. Full
details, flags, background scheduling, and a pure-`kiro-cli` orchestration option
are in [`docs/AUTOPILOT.md`](./docs/AUTOPILOT.md).

## Tests

```bash
pnpm test        # vitest run
npx tsc --noEmit # type-check
```
