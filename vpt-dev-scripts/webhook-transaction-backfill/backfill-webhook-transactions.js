/**
 * WebhookTransaction (DynamoDB) -> case_communication_events (PostgreSQL) backfill.
 *
 * Environment-specific (development | staging | preprod | production) and RESUMABLE: it
 * paginates the DynamoDB table with a Scan, and after every page persists a
 * checkpoint (the DynamoDB LastEvaluatedKey + running stats) to a per-environment
 * file. If the script is stopped or crashes, re-running it with the same --env
 * resumes from the last checkpoint instead of starting over.
 *
 * Only WebhookTransaction records with `createdAt < --before <epoch-ms>` are
 * published to Postgres.
 *
 * ── Field mapping (WebhookTransaction -> case_communication_events) ──
 *   referenceId        -> workflow_id
 *   referenceId        -> identifiers.workflowId      + identifier_values[]
 *   id                 -> identifiers.transactionId   + identifier_values[]
 *   url                -> path
 *   createdAt          -> created_at
 *   headers            -> request_headers
 *   payload            -> request
 *   response           -> response
 *   httpStatus         -> status_code
 *   responseReceivedAt -> received_at   (falls back to createdAt when absent,
 *                                        since received_at is NOT NULL and is the
 *                                        partition key of the Postgres table)
 * Constant columns for a webhook send: direction='OUTBOUND', channel='WEBHOOK',
 * event_type='WEBHOOK_SEND', method='POST', service_name='notifications-service'.
 *
 * ── Usage ──
 *   # DRY RUN (scans + maps + prints, writes NOTHING to Postgres)
 *   node backfill-webhook-transactions.js --env development --before 1760000000000 --profile dev-profile
 *
 *   # LIVE (also inserts into Postgres)
 *   node backfill-webhook-transactions.js --env development --before 1760000000000 --profile dev-profile --execute
 *
 *   # Resume a previously-interrupted run (same --env; checkpoint is picked up automatically)
 *   node backfill-webhook-transactions.js --env development --before 1760000000000 --profile dev-profile --execute
 *
 *   # Start over, ignoring any saved checkpoint
 *   node backfill-webhook-transactions.js --env development --before 1760000000000 --profile dev-profile --execute --restart
 *
 * ── Arguments ──
 *   --env      (required) development | staging | preprod | production
 *   --before   (required) epoch milliseconds; only createdAt < this value is published
 *   --profile  (optional) AWS profile from ~/.aws; omit to use AWS_ACCESS_KEY_ID env vars
 *   --execute  (optional) actually insert into Postgres (default is dry run)
 *   --restart  (optional) ignore and overwrite any existing checkpoint
 *   --batch    (optional) Postgres insert batch size (default 200)
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({path: path.join(__dirname, '.env')});

const {DynamoDBClient} = require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient, ScanCommand} = require('@aws-sdk/lib-dynamodb');
const {SecretsManagerClient, GetSecretValueCommand} = require('@aws-sdk/client-secrets-manager');
const {fromEnv, fromIni} = require('@aws-sdk/credential-providers');
const {Pool} = require('pg');

// ─── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : null;
}
function hasFlag(name) {
    return args.includes(`--${name}`);
}

const ENVIRONMENT = getArg('env');
const BEFORE_RAW = getArg('before');
const AWS_PROFILE = getArg('profile');
const LIVE_MODE = hasFlag('execute');
const RESTART = hasFlag('restart');
const PG_BATCH_SIZE = Number(getArg('batch')) || 200;
const DDB_PAGE_LIMIT = 500; // DynamoDB Scan page size

function usageAndExit(message) {
    if (message) console.error(`Error: ${message}`);
    console.error(
        '\nUsage: node backfill-webhook-transactions.js --env <development|staging|preprod|production> ' +
            '--before <epoch-ms> [--profile <aws-profile>] [--execute] [--restart] [--batch <n>]'
    );
    process.exit(1);
}

if (!ENVIRONMENT) usageAndExit('--env is required.');
if (!BEFORE_RAW) usageAndExit('--before <epoch-ms> is required.');

const BEFORE_TS = Number(BEFORE_RAW);
if (!Number.isFinite(BEFORE_TS) || BEFORE_TS <= 0) {
    usageAndExit('--before must be a positive epoch-millisecond integer.');
}

if (!AWS_PROFILE && (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)) {
    usageAndExit(
        'provide credentials via --profile <aws-profile> or set BOTH AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.'
    );
}

// ─── Environment config ───────────────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, 'env-config.json');

function loadEnvironmentConfig(targetEnv) {
    let mapping;
    try {
        mapping = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (e) {
        usageAndExit(`Failed to load ${CONFIG_FILE}: ${e.message}`);
    }

    const entry = Object.entries(mapping.environments).find(([, env]) => env.name === targetEnv);
    if (!entry) {
        const available = Object.values(mapping.environments)
            .map(e => e.name)
            .join(', ');
        usageAndExit(`Environment "${targetEnv}" not found. Available: ${available}`);
    }

    const [accountId, envConfig] = entry;
    return {accountId, ...envConfig};
}

// ─── Checkpoint (resume) ──────────────────────────────────────────────────────

function checkpointPath(envName) {
    return path.join(__dirname, `.checkpoint-${envName}.json`);
}

function loadCheckpoint(envName) {
    const file = checkpointPath(envName);
    if (RESTART) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return null;
    }
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
        console.warn(`  ⚠️  Could not parse checkpoint ${file} (${e.message}); starting fresh.`);
        return null;
    }
}

function saveCheckpoint(envName, state) {
    fs.writeFileSync(checkpointPath(envName), JSON.stringify(state, null, 2));
}

function clearCheckpoint(envName) {
    const file = checkpointPath(envName);
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ─── Dry-run output ───────────────────────────────────────────────────────────

function dryRunOutputPath(envName) {
    return path.join(__dirname, `dry-run-output-${envName}.json`);
}

/** Turn an ordered values array back into a readable {column: value} object. */
function rowToObject(row) {
    const obj = {};
    INSERT_COLUMNS.forEach((col, i) => {
        obj[col] = row[i];
    });
    return obj;
}

// ─── AWS / DB clients ─────────────────────────────────────────────────────────

function buildCredentials() {
    return AWS_PROFILE ? fromIni({profile: AWS_PROFILE}) : fromEnv();
}

function buildDynamoClient(region) {
    const base = new DynamoDBClient({region, credentials: buildCredentials()});
    return DynamoDBDocumentClient.from(base, {
        marshallOptions: {removeUndefinedValues: true},
    });
}

async function getDbCredentials(region, db) {
    const secrets = new SecretsManagerClient({region, credentials: buildCredentials()});
    const response = await secrets.send(new GetSecretValueCommand({SecretId: db.secretName}));
    if (!response.SecretString) {
        throw new Error(`Secret ${db.secretName} has an empty SecretString`);
    }
    // Secret holds {username, password} (and may also carry host/port/dbname).
    const parsed = JSON.parse(response.SecretString);
    return {
        host: parsed.host || db.host,
        port: Number(parsed.port || db.port) || 5432,
        database: parsed.dbname || db.database,
        user: parsed.username,
        password: parsed.password,
    };
}

function buildPgPool(creds) {
    // Prefer a pinned RDS CA bundle (set VERIFICATION_DB_CA_BUNDLE to its path) so
    // the server certificate is actually verified. Without it we fall back to an
    // unverified TLS connection — acceptable only inside a trusted bastion/VPN,
    // and we warn loudly so a staging/production run does not silently skip
    // certificate validation.
    let ssl;
    const caBundlePath = process.env.VERIFICATION_DB_CA_BUNDLE;
    if (caBundlePath) {
        ssl = {
            ca: fs.readFileSync(caBundlePath, 'utf-8'),
            rejectUnauthorized: true,
        };
    } else {
        console.warn(
            '  ⚠️  TLS certificate verification DISABLED (no VERIFICATION_DB_CA_BUNDLE set). ' +
                'A MITM on the DB path would go undetected. Set VERIFICATION_DB_CA_BUNDLE to ' +
                'the RDS CA bundle path to enable verification.'
        );
        ssl = {rejectUnauthorized: false};
    }

    return new Pool({
        host: creds.host,
        port: creds.port,
        user: creds.user,
        password: creds.password,
        database: creds.database,
        ssl,
        max: 5,
        idleTimeoutMillis: 30000,
    });
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

const EVENT_TYPE = 'WEBHOOK_SEND';
const DIRECTION = 'OUTBOUND';
const CHANNEL = 'WEBHOOK';
const METHOD = 'POST';
const SERVICE_NAME = 'notifications-service';

/**
 * Column order MUST match INSERT_COLUMNS below.
 * Mirrors the Postgres case_communication_events schema.
 */
const INSERT_COLUMNS = [
    'trace_id',
    'workflow_id',
    'direction',
    'event_type',
    'method',
    'path',
    'route',
    'target_service',
    'request',
    'response',
    'request_headers',
    'response_headers',
    'identifiers',
    'identifier_values',
    'status_code',
    'error_code',
    'error_message',
    'received_at',
    'responded_at',
    'latency_ms',
    'created_at',
    'client_id',
    'channel',
    'service_name',
];

// Columns that need an explicit cast on their placeholder.
const COLUMN_CASTS = {
    request: 'jsonb',
    response: 'jsonb',
    request_headers: 'jsonb',
    identifiers: 'jsonb',
    identifier_values: 'text[]',
    received_at: 'bigint',
    created_at: 'bigint',
};

/**
 * Serialise a value for a jsonb column.
 *   - `nullable=false` (request/response — NOT NULL in the schema): absent values
 *     become '{}' so the NOT NULL constraint is satisfied.
 *   - `nullable=true`  (request_headers — nullable): absent values become null so
 *     "no headers recorded" stays distinct from "empty object".
 */
function toJsonb(value, {nullable = false} = {}) {
    if (value === undefined || value === null) return nullable ? null : '{}';
    if (typeof value === 'string') {
        // response/payload may already be a JSON string; wrap non-JSON as a string value.
        try {
            JSON.parse(value);
            return value;
        } catch {
            return JSON.stringify(value);
        }
    }
    return JSON.stringify(value);
}

/**
 * Maps one WebhookTransaction item to the flat ordered values array for one
 * Postgres row. Returns null (and the reason) when the record must be skipped.
 */
function mapRecord(item) {
    const createdAt = Number(item.createdAt);
    if (!Number.isFinite(createdAt)) {
        return {row: null, skipReason: 'missing/invalid createdAt'};
    }
    if (createdAt >= BEFORE_TS) {
        return {row: null, skipReason: 'createdAt >= --before cutoff'};
    }

    const transactionId = item.id;
    if (!transactionId) {
        return {row: null, skipReason: 'missing id'};
    }

    const referenceId = item.referenceId ?? null;

    // identifiers (jsonb) + identifier_values (text[]): transactionId always,
    // workflowId only when referenceId is present.
    const identifiers = {transactionId};
    const identifierValues = [transactionId];
    if (referenceId) {
        identifiers.workflowId = referenceId;
        identifierValues.push(referenceId);
    }

    // received_at is NOT NULL (partition key). responseReceivedAt is optional on the
    // entity, so fall back to createdAt when the webhook never recorded a response.
    const receivedAt =
        item.responseReceivedAt != null && Number.isFinite(Number(item.responseReceivedAt))
            ? Number(item.responseReceivedAt)
            : createdAt;

    const statusCode =
        item.httpStatus != null && Number.isFinite(Number(item.httpStatus))
            ? Number(item.httpStatus)
            : null;

    const row = {
        trace_id: null,
        workflow_id: referenceId,
        direction: DIRECTION,
        event_type: EVENT_TYPE,
        method: METHOD,
        path: item.url ?? null,
        route: null,
        target_service: null,
        request: toJsonb(item.payload),
        response: toJsonb(item.response),
        request_headers: toJsonb(item.headers, {nullable: true}),
        response_headers: null,
        identifiers: JSON.stringify(identifiers),
        identifier_values: identifierValues,
        status_code: statusCode,
        error_code: null,
        error_message: null,
        received_at: receivedAt,
        responded_at: null,
        latency_ms: null,
        created_at: createdAt,
        client_id: null,
        channel: CHANNEL,
        service_name: SERVICE_NAME,
    };

    return {row: INSERT_COLUMNS.map(col => row[col]), transactionId, skipReason: null};
}

// ─── Postgres insert ──────────────────────────────────────────────────────────

const COLUMN_COUNT = INSERT_COLUMNS.length;

function buildInsertQuery(rowCount) {
    const rowPlaceholders = [];
    for (let r = 0; r < rowCount; r++) {
        const placeholders = INSERT_COLUMNS.map((col, c) => {
            const paramNumber = r * COLUMN_COUNT + c + 1;
            const cast = COLUMN_CASTS[col];
            return cast ? `$${paramNumber}::${cast}` : `$${paramNumber}`;
        });
        rowPlaceholders.push(`(${placeholders.join(', ')})`);
    }
    // NOTE: ON CONFLICT DO NOTHING does NOT de-duplicate this backfill. The PK is
    // (received_at, id) where `id` is GENERATED ALWAYS AS IDENTITY, so every INSERT
    // gets a brand-new id and never conflicts. Real idempotency comes from the
    // transactionId pre-check in filterNewTransactionIds() below. This clause is
    // kept only as a defensive no-op against a hypothetical future unique constraint.
    return `
        INSERT INTO case_communication_events (${INSERT_COLUMNS.join(', ')})
        VALUES ${rowPlaceholders.join(', ')}
        ON CONFLICT DO NOTHING
    `;
}

/**
 * Returns the subset of `rows` whose transactionId is NOT already present in
 * case_communication_events. This is what makes re-runs / resumes idempotent:
 * because the PK is DB-generated, we cannot rely on ON CONFLICT, so we key on the
 * natural identity (identifiers->>'transactionId' for this event_type) instead.
 *
 * Each entry of `rows` is {row, transactionId}.
 */
async function filterNewTransactionIds(pool, rows) {
    if (rows.length === 0) return [];
    const ids = rows.map(r => r.transactionId);
    const {rows: existing} = await pool.query(
        `SELECT identifiers->>'transactionId' AS txn_id
           FROM case_communication_events
          WHERE event_type = $1
            AND identifiers->>'transactionId' = ANY($2::text[])`,
        [EVENT_TYPE, ids]
    );
    const seen = new Set(existing.map(e => e.txn_id));
    return rows.filter(r => !seen.has(r.transactionId));
}

async function insertBatch(pool, rows) {
    if (rows.length === 0) return;
    const query = buildInsertQuery(rows.length);
    const values = rows.flat();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(query, values);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const {accountId, name: envName, region, dynamoTableName, db} = loadEnvironmentConfig(
        ENVIRONMENT
    );

    console.log('\nWebhookTransaction → case_communication_events Backfill');
    console.log('======================================================');
    console.log(`Environment : ${envName} (${accountId})`);
    console.log(`Region      : ${region}`);
    console.log(`Dynamo table: ${dynamoTableName}`);
    console.log(`Postgres    : ${db.host}:${db.port}/${db.database}`);
    console.log(`Credentials : ${AWS_PROFILE ? `profile [${AWS_PROFILE}]` : 'env vars'}`);
    console.log(`Before (ms) : ${BEFORE_TS}  (${new Date(BEFORE_TS).toISOString()})`);
    console.log(`Mode        : ${LIVE_MODE ? '⚡ LIVE (writes to Postgres)' : '🔍 DRY RUN (no writes)'}`);
    console.log(`PG batch    : ${PG_BATCH_SIZE}`);

    const dynamo = buildDynamoClient(region);

    // Resume state
    const prior = loadCheckpoint(envName);
    const state = prior || {
        env: envName,
        mode: LIVE_MODE ? 'live' : 'dry-run',
        before: BEFORE_TS,
        lastEvaluatedKey: null,
        scanned: 0,
        eligible: 0,
        inserted: 0, // rows actually inserted (live mode)
        wouldInsert: 0, // rows that would be inserted (dry-run mode)
        skipped: 0, // records skipped during mapping (cutoff / missing fields)
        duplicatesSkipped: 0, // rows skipped because transactionId already in Postgres
        completed: false,
        startedAt: new Date().toISOString(),
    };
    if (state.wouldInsert === undefined) state.wouldInsert = 0;
    if (state.duplicatesSkipped === undefined) state.duplicatesSkipped = 0;

    const currentMode = LIVE_MODE ? 'live' : 'dry-run';

    if (prior) {
        // A dry-run checkpoint must NOT be resumed by a live run (or vice versa):
        // the live run would start past the pages the dry run already scanned and
        // silently never insert them. Mirror the --before guard and force --restart.
        const checkpointMode = prior.mode ?? 'live'; // old checkpoints predate the mode field
        if (checkpointMode !== currentMode) {
            usageAndExit(
                `Checkpoint was saved during a ${checkpointMode} run but you are now running in ` +
                    `${currentMode} mode. Use --restart to discard the checkpoint and start over.`
            );
        }
        if (prior.before !== BEFORE_TS) {
            usageAndExit(
                `Checkpoint was created with --before ${prior.before} but you passed ${BEFORE_TS}. ` +
                    `Use --restart to discard it, or re-run with --before ${prior.before}.`
            );
        }
        if (prior.completed) {
            console.log('\n✅ Checkpoint marks this environment as already COMPLETED.');
            console.log('   Pass --restart to run it again from scratch.');
            return;
        }
        console.log(
            `\n↩️  Resuming from checkpoint — scanned=${prior.scanned}, eligible=${prior.eligible}, ` +
                `${LIVE_MODE ? `inserted=${prior.inserted}` : `would-insert=${prior.wouldInsert ?? 0}`}, ` +
                `skipped=${prior.skipped}.`
        );
    }

    // Safe to stamp now — a mismatched resume was already rejected above.
    state.mode = currentMode;

    // Open the Postgres pool only after the resume guards pass, so a mode/--before
    // mismatch exits without an AWS Secrets Manager call or a DB connection.
    let pool = null;
    if (LIVE_MODE) {
        const creds = await getDbCredentials(region, db);
        pool = buildPgPool(creds);
    }

    const startTime = Date.now();
    let buffer = [];

    // In dry run, stream mapped rows to a readable JSON array file so you can
    // inspect exactly what WOULD be inserted, column by column. Reset the file at
    // the start of a fresh (non-resumed) run; append across pages/resumes.
    const dryRunFile = dryRunOutputPath(envName);
    let dryRunWroteAny = prior && !prior.completed ? fs.existsSync(dryRunFile) : false;
    if (!LIVE_MODE && !dryRunWroteAny) {
        fs.writeFileSync(dryRunFile, '[\n');
    }

    function appendDryRunRows(entries) {
        if (entries.length === 0) return;
        const chunks = entries.map(e => '  ' + JSON.stringify(rowToObject(e.row)));
        const prefix = dryRunWroteAny ? ',\n' : '';
        fs.appendFileSync(dryRunFile, prefix + chunks.join(',\n'));
        dryRunWroteAny = true;
    }

    async function flushBuffer() {
        if (buffer.length === 0) return;
        if (LIVE_MODE) {
            // Idempotency: drop any transactionId already in Postgres BEFORE inserting.
            // The PK is DB-generated, so ON CONFLICT cannot dedup; this pre-check is
            // what keeps a resume/retry from re-inserting already-committed rows of
            // an interrupted page as duplicates.
            const fresh = await filterNewTransactionIds(pool, buffer);
            state.duplicatesSkipped += buffer.length - fresh.length;

            // Let an insert failure bubble up to main() and halt the run. The
            // checkpoint for this page has NOT been saved yet, so re-running
            // resumes from the start of the current page; the pre-check above then
            // skips whatever already committed — no duplicates, no orphans.
            await insertBatch(pool, fresh.map(e => e.row));
            state.inserted += fresh.length;
        } else {
            appendDryRunRows(buffer);
            state.wouldInsert += buffer.length;
        }
        buffer = [];
    }

    do {
        const page = await dynamo.send(
            new ScanCommand({
                TableName: dynamoTableName,
                Limit: DDB_PAGE_LIMIT,
                ExclusiveStartKey: state.lastEvaluatedKey || undefined,
            })
        );

        const items = page.Items || [];
        state.scanned += items.length;

        for (const item of items) {
            const {row, transactionId} = mapRecord(item);
            if (!row) {
                state.skipped++;
                continue;
            }
            state.eligible++;
            buffer.push({row, transactionId});
            if (buffer.length >= PG_BATCH_SIZE) {
                await flushBuffer();
            }
        }

        // Flush remainder of this page, then checkpoint so a stop here is resumable.
        await flushBuffer();

        state.lastEvaluatedKey = page.LastEvaluatedKey || null;
        state.completed = !page.LastEvaluatedKey;
        saveCheckpoint(envName, state);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(
            `  [scan] scanned=${state.scanned} eligible=${state.eligible} ` +
                `${LIVE_MODE ? `inserted=${state.inserted} dup-skipped=${state.duplicatesSkipped}` : `would-insert=${state.wouldInsert}`} ` +
                `skipped=${state.skipped} (${elapsed}s)` +
                `${state.lastEvaluatedKey ? ' …more' : ''}`
        );
    } while (state.lastEvaluatedKey);

    // Close the dry-run JSON array so the file is valid JSON.
    if (!LIVE_MODE) {
        fs.appendFileSync(dryRunFile, '\n]\n');
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n═════════════════════════════════════');
    console.log(`Scanned       : ${state.scanned}`);
    console.log(`Eligible      : ${state.eligible}  (createdAt < ${BEFORE_TS})`);
    console.log(
        `${LIVE_MODE ? 'Inserted      ' : 'Would insert  '}: ${
            LIVE_MODE ? state.inserted : state.wouldInsert
        }`
    );
    console.log(`Skipped       : ${state.skipped}`);
    if (LIVE_MODE) {
        console.log(`Dup-skipped   : ${state.duplicatesSkipped}  (transactionId already present)`);
    }
    console.log(`Elapsed       : ${totalElapsed}s`);

    // Reaching here means every page's batches committed (a batch failure would
    // have thrown and halted the run before the checkpoint advanced).
    clearCheckpoint(envName);
    console.log('\n✅ Completed. Checkpoint cleared.');

    if (!LIVE_MODE) {
        console.log(
            `\nℹ️  Dry run — nothing was written to Postgres. Mapped rows written to:\n` +
                `   ${dryRunFile}\n` +
                `   Review them, then re-run with --execute to backfill.`
        );
    }

    if (pool) await pool.end();
}

main().catch(error => {
    console.error('\nFatal error:', error.stack || error.message);
    process.exit(1);
});
