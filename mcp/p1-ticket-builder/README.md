# p1-ticket-builder MCP

Builds **P1 bug-ticket payloads** that follow the DFG P1 pattern (see
[DT-47018](https://dataflowplus.atlassian.net/browse/DT-47018)): a structured
description plus a machine-readable `KIRO-EXEC` block.

It does **not** create the ticket itself — MCP servers can't call each other.
It returns a ready-to-create payload that Kiro then passes to the **Jira MCP**
`jira_create_issue`. This keeps Jira auth in one place (the existing
`mcp-atlassian` server).

## Tools

### `get_p1_template`
Returns the input schema (field names) + a filled example based on DT-47018.
Call this first if you're unsure what to provide.

### `build_p1_ticket`
Takes the bug details and returns arguments that map **1:1 to the current
`jira_create_issue` contract** — forward them verbatim (note `additional_fields`
is already a JSON *string*):
```json
{
  "ready_for": "jira_create_issue",
  "jira_create_issue_args": {
    "project_key": "DT",
    "issue_type": "Bug",
    "summary": "[p1][EXTERNAL_BUG] <title>",
    "description": "...full templated markdown incl. KIRO-EXEC...",
    "additional_fields": "{\"priority\":{\"name\":\"P1 High\"},\"labels\":[...]}",
    "components": "Verification Platform,VP-VerificationRequestService"
  }
}
```

**Inputs** (see `get_p1_template` for the full list): `title`, `bugType`
(default `EXTERNAL_BUG`), `project` (default `DT`), `scenario`, `currentCase`,
`mitigationDone`, `regressionType` + `regressionReason`, `frequency`,
`unhandledScenario`, `proposedSolution` (string or list of steps), `utCoverage`,
`testAutomation`, `otherCasesImpacted`, `labels`, `components`, and `kiroExec`
(`autonomy`, `primary_repos`, `context_repos`, `multi_repo`, `base_branch`,
`target_branch`, `hotfix`, `cherry_pick_to`, `branch_name`, `reviewers`,
`tests_required`, `manual_testing_artifacts`).

## Workflow (how Kiro uses it)

1. `build_p1_ticket(...)` → get `jira_create_issue_args`.
2. Call the Jira MCP `jira_create_issue` with those args **verbatim**
   (`additional_fields` is already a JSON string setting `priority: P1 High` and
   `labels`).

Just ask Kiro: *"build a P1 ticket for <bug> and create it"* — it will call
`build_p1_ticket` then `jira_create_issue`.

## Build & register

```bash
npm install
npm run build
```

Register in `~/.kiro/settings/mcp.json`:
```json
"p1-ticket-builder": {
  "command": "node",
  "args": ["<path>/dev-toolbox/mcp/p1-ticket-builder/dist/index.js"],
  "autoApprove": ["get_p1_template", "build_p1_ticket"]
}
```
Then reconnect the server from the MCP panel. No credentials needed (creation
goes through the Jira MCP).
