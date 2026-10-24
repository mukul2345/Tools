# WebhookTransaction → case_communication_events Backfill

One-off, **environment-specific** and **resumable** backfill that reads
`WebhookTransaction` records from DynamoDB and inserts them into the
`case_communication_events` PostgreSQL table.

Only records with `createdAt < --before <epoch-ms>` are published.

---

## Field mapping

| WebhookTransaction (DynamoDB) | case_communication_events (Postgres) |
|---|---|
| `referenceId` | `workflow_id` |
| `referenceId` | `identifiers.workflowId` + `identifier_values[]` |
| `id` | `identifiers.transactionId` + `identifier_values[]` |
| `url` | `path` |
| `createdAt` | `created_at` |
| `headers` | `request_headers` |
| `payload` | `request` |
| `response` | `response` |
| `httpStatus` | `status_code` |
| `responseReceivedAt` | `received_at` (falls back to `createdAt` when absent) |

Constant columns for a webhook send: `direction='OUTBOUND'`,
`channel='WEBHOOK'`, `event_type='WEBHOOK_SEND'`, `method='POST'`,
`service_name='notifications-service'`.

> `received_at` is `NOT NULL` and is the table's partition key. Since
> `responseReceivedAt` is optional on the entity, the script uses `createdAt` as
> the `received_at` fallback for any record that never recorded a response time.

---

## Prerequisites

1. Node.js 18+ and `npm install` in this directory.
2. AWS credentials for the target account — either `--profile <name>`, or **both**
   `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` set.
3. **Network access to the target Postgres** (the verification DB usually lives
   in a private subnet — run from a bastion/VPN with reachability).
4. Fill in `env-config.json` with the correct `host` and `secretName` for each
   environment (the `REPLACE_WITH_*` placeholders). The Secrets Manager secret
   must contain `{ "username": ..., "password": ... }`.
5. _(Recommended for staging/production)_ set `VERIFICATION_DB_CA_BUNDLE` to the
   RDS CA bundle path so the DB server certificate is verified. Without it the
   connection still works but skips certificate verification (and warns).

---

## Environment config — `env-config.json`

| Environment | Account ID | Region |
|---|---|---|
| development | 780917974971 | ap-south-1 |
| staging | 471112785275 | ap-south-1 |
| preprod | 058264398403 | ap-south-1 |
| production | 891377067284 | eu-west-1 |

Each entry carries the DynamoDB table name (`WebhookTransaction`) and the
Postgres `host` / `port` / `database` / `secretName`.

---

## Usage

```bash
npm install

# DRY RUN — scans DynamoDB, maps records, prints counts, and writes the mapped
# rows to dry-run-output-<env>.json for inspection. Writes NOTHING to Postgres.
node backfill-webhook-transactions.js \
  --env development \
  --before 1760000000000 \
  --profile dev-profile

# LIVE — same, but inserts into Postgres
node backfill-webhook-transactions.js \
  --env development \
  --before 1760000000000 \
  --profile dev-profile \
  --execute
```

### Arguments

| Argument | Required | Description |
|---|---|---|
| `--env` | Yes | `development`, `staging`, `preprod`, or `production` |
| `--before` | Yes | Epoch **milliseconds**; only `createdAt < this` is published |
| `--profile` | No | AWS profile from `~/.aws`. Omit to use env-var credentials. |
| `--execute` | No | Actually insert into Postgres. Default is a dry run that writes `dry-run-output-<env>.json`. |
| `--restart` | No | Ignore and overwrite any saved checkpoint, starting from scratch. |
| `--batch` | No | Postgres insert batch size (default `200`). |

Tip: get `--before` for a date with
`node -e "console.log(Date.parse('2026-10-01T00:00:00Z'))"`.

---

## Resuming an interrupted run

The script paginates the DynamoDB `Scan` and, **after every page**, writes a
checkpoint to `.checkpoint-<env>.json` containing the DynamoDB
`LastEvaluatedKey` and the running counters.

- If the process is stopped (Ctrl-C), crashes, or the box reboots, just **re-run
  the exact same command** — it picks up the checkpoint and continues from the
  last completed page.
- The checkpoint pins the `--before` value; re-running with a different
  `--before` is refused (use `--restart` to discard).
- On clean completion the checkpoint is **deleted**.
- **A failed insert halts the run immediately** (the error bubbles up and the
  process exits non-zero) *before* the current page's checkpoint is saved. So a
  re-run resumes from the **start of the failed page**.
- **Idempotency** does NOT come from `ON CONFLICT`. The table's PK is
  `(received_at, id)` where `id` is `GENERATED ALWAYS AS IDENTITY`, so every
  `INSERT` gets a fresh `id` and never conflicts — `ON CONFLICT DO NOTHING` would
  re-insert duplicates. Instead, before inserting each batch the script queries
  `case_communication_events` for any `identifiers->>'transactionId'` (scoped to
  `event_type = 'WEBHOOK_SEND'`) already present and **drops those rows**. That
  makes re-runs and resumes safe: already-committed `transactionId`s are skipped
  (reported as `Dup-skipped`) rather than duplicated.
- `--restart` deletes the checkpoint and starts over.

Because the checkpoint only advances once a page's batches all succeed, and each
batch is de-duplicated against existing `transactionId`s before insert, re-running
after an interruption or failure resumes near where it stopped without creating
duplicate rows.

---

## Dry run

Dry run is the **default** (omit `--execute`). It:

- opens **no** Postgres connection and writes **nothing** to the database;
- scans DynamoDB and applies the exact same mapping as the live run;
- prints `Scanned` / `Eligible` / `Would insert` / `Skipped` counts;
- writes every mapped row to **`dry-run-output-<env>.json`** as a readable
  `{column: value}` array, so you can inspect precisely what the live run would
  insert (column by column) before committing to it.

The dry-run file is reset at the start of a fresh run and appended across pages.
Run a dry run, open `dry-run-output-<env>.json`, sanity-check a few records, then
re-run the same command with `--execute`.

---

## Notes

- DynamoDB `WebhookTransaction` has no `createdAt` GSI, so the script does a full
  paginated table `Scan` and filters `createdAt < --before` client-side — correct
  for a one-off backfill.
- Always do a **dry run first** and sanity-check `Eligible` / `Would insert`
  counts before `--execute`.
- **Dedup:** each live batch is pre-filtered against existing
  `identifiers->>'transactionId'` (for `event_type = 'WEBHOOK_SEND'`) so re-runs
  never duplicate. This is one extra `SELECT ... = ANY($ids)` per batch; the
  `idx_cie_identifiers` GIN index and the `created_at < --before` cutoff keep the
  data set bounded for a one-off backfill. If you ever need a hard guarantee at
  the DB level, add a unique index on `(event_type, (identifiers->>'transactionId'))`
  including the partition key `received_at` — but that is a schema change outside
  this script's scope.
- `request` / `response` / `identifiers` are written as `jsonb` (NOT NULL in the
  schema, so an absent `payload`/`response` becomes `{}`); `request_headers` /
  `response_headers` are nullable `jsonb` and stay **`null`** when absent (so "no
  headers recorded" is distinct from "empty object"); `identifier_values` is
  `text[]`; `received_at` / `created_at` are `bigint`.
- Constant `service_name` written for each row is **`notifications-service`**
  (matches the service's own `SERVICE_NAME` config).
- **TLS:** by default the Postgres connection does **not** verify the server
  certificate (acceptable only inside a trusted bastion/VPN; the script warns).
  To verify properly, download the RDS CA bundle and point
  `VERIFICATION_DB_CA_BUNDLE` at it:
  ```bash
  export VERIFICATION_DB_CA_BUNDLE=/path/to/rds-global-bundle.pem
  ```
