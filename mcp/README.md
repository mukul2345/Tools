# Local MCP servers

Custom [Model Context Protocol](https://modelcontextprotocol.io) servers we use
with Kiro, shared so the whole team can run the same tooling.

| Server | What it does | Needs creds? |
|--------|--------------|:---:|
| `workflow-mcp-server` | Query the verification workflow engine — entities, runtime errors, execution steps, application logs (Athena/S3), audit trail | ✅ `.env` |
| `dynamodb-mcp-server` | Query DynamoDB across develop/staging/preprod/production; schema-aware `query_by_attributes` avoids full scans | ✅ `.env` |
| `git-worktree-mcp-server` | Discover repos and manage git worktrees across your dev root | ❌ (env paths only) |
| `p1-ticket-builder` | Build P1 bug-ticket payloads (templated description + KIRO-EXEC) to create via the Jira MCP | ❌ |

## One-time setup (per server)

Each server is a Node project. Build it, then point `mcp.json` at its
`dist/index.js`.

```bash
cd dev-toolbox/mcp/<server>
npm install       # or: pnpm install
npm run build
```

For the two that need credentials, copy the template and fill in values
(`.env` is gitignored — never commit real secrets):

```bash
cp .env.example .env   # then edit .env
```

## mcp.json configuration

Add these under `mcpServers` in `~/.kiro/settings/mcp.json`. Replace
`<your-dev-root>` with the absolute path to your checkout root (the folder that
contains `dataflow-repo/`), e.g. `/Users/you/dataflow-dev`.

```jsonc
{
  "mcpServers": {
    "workflow-mcp-server": {
      "command": "node",
      "args": ["<your-dev-root>/dataflow-repo/dev-toolbox/mcp/workflow-mcp-server/dist/index.js"],
      "autoApprove": [
        "get_entity", "query_entities", "search_cases", "get_root_workflow",
        "get_child_workflows", "get_referenced_entities", "get_execution_steps",
        "get_workflow_run_logs", "query_audit_trail", "get_workflow_run_events",
        "search_application_logs", "get_sql_query_templates",
        "get_runtime_error_details", "execute_sql_log_query"
      ]
    },

    "dynamodb-mcp-server": {
      "command": "node",
      "args": ["<your-dev-root>/dataflow-repo/dev-toolbox/mcp/dynamodb-mcp-server/dist/index.js"],
      "autoApprove": [
        "list_environments", "list_tables", "describe_table", "get_item",
        "query_table", "query_by_attributes", "scan_table"
      ]
    },

    "git-worktree-mcp-server": {
      "command": "node",
      "args": ["<your-dev-root>/dataflow-repo/dev-toolbox/mcp/git-worktree-mcp-server/dist/index.js"],
      "env": {
        "WORKTREE_SCAN_ROOT": "<your-dev-root>",
        "WORKTREE_ROOT": "<your-dev-root>/.worktrees"
      },
      "autoApprove": ["discover_repos", "list_worktrees"]
    },

    "p1-ticket-builder": {
      "command": "node",
      "args": ["<your-dev-root>/dataflow-repo/dev-toolbox/mcp/p1-ticket-builder/dist/index.js"],
      "autoApprove": ["get_p1_template", "build_p1_ticket"]
    }
  }
}
```

After editing `mcp.json`, reconnect the servers from Kiro's MCP panel (or restart Kiro).

## Per-server notes

### workflow-mcp-server  — needs `.env`
`cp .env.example .env` and set `AT_TOKEN`, `RT_TOKEN`, `WORKFLOW_TOOLS_URL`.
Tokens are your `at`/`rt` session cookies from any DFG portal (DevTools →
Application → Cookies); they're short-lived — refresh when calls start
returning 401.

### dynamodb-mcp-server  — needs `.env`
`cp .env.example .env` and set the AWS keys per environment
(`STAGING_*`, `DEVELOP_*`, `PREPROD_*`, and `PROD_*` to enable production).
Regions default to `ap-south-1` (prod `eu-west-1`); override with `*_AWS_REGION`.
Prefer `query_by_attributes` / `query_table` over `scan_table`; use
`describe_table` to see `queryableAttributes` and `accessPatterns`.

### git-worktree-mcp-server  — no creds
Configure only via `mcp.json` `env`: set `WORKTREE_SCAN_ROOT` to your dev root
(defaults to the process CWD) and `WORKTREE_ROOT` for where worktrees live
(defaults to `<root>/.worktrees`).

### p1-ticket-builder  — no creds
Builds a P1 payload; the actual ticket is created through the Jira MCP
(`mcp-atlassian`), so no Jira auth lives here. See its own README for the
`build_p1_ticket` → `jira_create_issue` workflow.

## Adding a new MCP here

1. Create `dev-toolbox/mcp/<server>/` (Node + `@modelcontextprotocol/sdk`).
2. Include a `.gitignore` with `node_modules/`, `dist/`, and `.env` (if it has secrets).
3. Add a `.env.example` (never commit real `.env`).
4. Add its `mcp.json` snippet to this README.
