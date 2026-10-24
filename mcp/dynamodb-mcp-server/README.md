# DynamoDB MCP Server

An MCP server for querying DynamoDB tables across environments
(`develop`, `staging`, `preprod`, `production`). It is **schema-aware**: it can
inspect a table's keys/indexes and route reads to a Query instead of an
expensive full-table Scan.

## Tools

| Tool | Description |
|------|-------------|
| `list_environments` | Show configured environments and whether creds are set |
| `list_tables` | List tables in an environment, optional name filter |
| `describe_table` | Table schema + indexes, plus derived `accessPatterns` and `queryableAttributes` |
| `get_item` | Fetch a single item by primary key |
| `query_table` | Query a table/GSI with an explicit key condition |
| `query_by_attributes` | **Schema-aware fetch that avoids scans** — give an equality map, it auto-routes to the right key/GSI; refuses to scan unless `allowScan=true` |
| `scan_table` | Filtered scan — last resort on large tables |

## Setup

```bash
cd dev-toolbox/mcp/dynamodb-mcp-server
npm install
npm run build
```

### Credentials (`.env`)

Credentials come from a local `.env` (or real env vars) — **not** hardcoded in
source. Copy the template and fill in your keys:

```bash
cp .env.example .env   # then edit
```

```
STAGING_AWS_ACCESS_KEY_ID=...
STAGING_AWS_SECRET_ACCESS_KEY=...
DEVELOP_AWS_ACCESS_KEY_ID=...
DEVELOP_AWS_SECRET_ACCESS_KEY=...
PREPROD_AWS_ACCESS_KEY_ID=...
PREPROD_AWS_SECRET_ACCESS_KEY=...
# Fill these to enable the "production" environment:
# PROD_AWS_ACCESS_KEY_ID=...
# PROD_AWS_SECRET_ACCESS_KEY=...
# PROD_AWS_REGION=eu-west-1
```

Regions default to `ap-south-1` (production `eu-west-1`); override any with
`<ENV>_AWS_REGION`. `.env` is gitignored — never commit real credentials.

### Register in `mcp.json`

```json
"dynamodb-mcp-server": {
  "command": "node",
  "args": ["<your-dev-root>/dataflow-repo/dev-toolbox/mcp/dynamodb-mcp-server/dist/index.js"],
  "autoApprove": ["list_environments","list_tables","describe_table","get_item","query_table","query_by_attributes","scan_table"]
}
```

## Usage

**Prefer `query_by_attributes`** — it finds the right access path for you and
never scans unless you opt in:

```
query_by_attributes(environment="production", tableName="ClaimItem",
  attributes={"verificationRequestId": "VerificationRequest@abc123", "status": "ACTIVE"})
# → auto-queries the verificationRequestId GSI; `status` becomes a post-query filter.
```

Not sure which attributes are queryable? Ask the schema:
```
describe_table(environment="production", tableName="ClaimItem")
# → returns keySchema, GSIs/LSIs, plus `queryableAttributes` and `accessPatterns`.
```

Explicit query / point-read / scan:
```
query_table(environment="staging", tableName="ClaimItem",
  indexName="verificationRequestId-index",
  keyCondition="verificationRequestId = :vrId",
  expressionValues={":vrId": "VerificationRequest@abc123"})

get_item(environment="staging", tableName="VerificationRequest",
  key={"id": "VerificationRequest@abc123"})

scan_table(environment="staging", tableName="Workflow",
  filterExpression="#s = :state", expressionAttributeNames={"#s": "state"},
  expressionValues={":state": "RE_VERIFICATION"})   # last resort
```

## Security

- **`src/environments.ts` contains no secrets** — it reads from `.env`/env vars,
  so it is safe to commit and share.
- **`.env` is gitignored** — this is where real credentials live locally.
- Each teammate copies `.env.example` → `.env` and fills their own keys.
