# Workflow MCP Server

An MCP server for investigating the verification workflow platform — query
entities, trace workflow runs, read runtime errors, and search production
application logs (via the workflow-tools-service log API / Athena).

## Tools (high level)

| Area | Tools |
|------|-------|
| Entities | `get_entity`, `query_entities`, `get_referenced_entities`, `search_cases` |
| Workflows | `get_root_workflow`, `get_child_workflows`, `get_workflow_run_events`, `get_execution_steps`, `get_workflow_run_logs` |
| Runtime errors | `get_runtime_error_counts`, `get_runtime_error_details` |
| Logs | `search_application_logs`, `execute_sql_log_query`, `get_sql_query_templates` |
| Audit | `query_audit_trail` |

## Setup

```bash
cd dev-toolbox/mcp/workflow-mcp-server
npm install
npm run build
```

### Credentials (`.env`)

Log/API access needs your session tokens and the service base URL. Copy the
template and fill it in:

```bash
cp .env.example .env   # then edit
```

```
AT_TOKEN=<your at cookie>
RT_TOKEN=<your rt cookie>
WORKFLOW_TOOLS_URL=<workflow-tools-service base url>
```

Get `AT_TOKEN`/`RT_TOKEN` from any DFG portal in the browser (DevTools →
Application → Cookies → `at` / `rt`). They're short-lived — refresh them when
calls start returning 401. `.env` is gitignored — never commit tokens.

> This `.env` is also the canonical source the `proactive-error-analyser` reads
> for log auth, so keeping it current benefits both tools.

### Register in `mcp.json`

```json
"workflow-mcp-server": {
  "command": "node",
  "args": ["<your-dev-root>/dataflow-repo/dev-toolbox/mcp/workflow-mcp-server/dist/index.js"],
  "autoApprove": [
    "get_entity","query_entities","search_cases","get_root_workflow",
    "get_child_workflows","get_referenced_entities","get_execution_steps",
    "get_workflow_run_logs","query_audit_trail","get_workflow_run_events",
    "search_application_logs","get_sql_query_templates",
    "get_runtime_error_details","execute_sql_log_query"
  ]
}
```

After editing `mcp.json`, reconnect the server from Kiro's MCP panel.

## Usage notes

- **Log search** (`search_application_logs`): windows are capped at ~10 minutes;
  pass `serviceName`, `startTime`, `endTime`, optional `searchTerm`.
- **SQL log queries** (`execute_sql_log_query`): time range capped at ~1 hour;
  the `log_data` table has columns like `date`, `level`, `message`, `traceId`.
  Start from `get_sql_query_templates`.
- **Rebuild + reconnect** after any code change so the running server picks it up.
