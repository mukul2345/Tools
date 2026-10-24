/**
 * DT-56285: Analyze claims stuck at VALIDATED with a COMPLETED claim workflow
 *
 * READ-ONLY. Makes no writes of any kind.
 *
 * Input:  claim_items_with_progress_evidence.json (Athena output of
 *         DT-56285-validated-claim-completed-workflow.sql), placed in this directory.
 *         See INPUT_CANDIDATES for the filenames checked and loadClaimRows for the
 *         JSON shapes accepted (array of rows, array of ID strings, wrapped array,
 *         or newline-delimited JSON).
 *
 * For every claimItemId in the input this does two point reads:
 *   1. live ClaimItem   — is it STILL VALIDATED? is it legacy?
 *   2. live Component   — componentStatus, which IS the recovery value
 *
 * Recovery value = componentStatus.
 *
 * The component is not a parallel guess at the claim's status, it is a mirror of
 * it: ComponentService.determineTargetComponentStatus derives componentStatus
 * FROM claimStatus (VERIFIED_APPROVED/VERIFIED_REJECTED/UNABLE_TO_VERIFY, and it
 * throws on anything else). So the component holds the last persisted copy of the
 * very claimStatus we are restoring, including any accreditation adjustment that
 * updateClaimStatusFromAccreditation applied.
 *
 * The component must itself be terminal. ComponentStatus has no VALIDATED member;
 * its non-terminal values are DRAFT and UNDER_REVIEW. A component sitting in
 * either means verification never completed, so there is nothing to restore and
 * the claim goes to manual review rather than being patched.
 *
 * The AuditTrail cross-check was dropped deliberately — see README.
 *
 * Buckets written:
 *   ready-to-mitigate.json    componentStatus is one of the three terminal values
 *   needs-manual-review.json  component non-terminal, not found, or no componentId
 *   already-repaired.json     live claim is no longer VALIDATED — nothing to do
 *   excluded-legacy.json      legacy=true (Report Transfer with Past Case placeholders)
 *   fetch-errors.json         transient failures, safe to re-run
 *
 * Usage:
 *   node analyze.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

// All input and output paths resolve against THIS FILE's directory, not the shell's
// cwd, so the script behaves identically whether it is run from inside the folder
// or as `node dev-toolbox/vpt-dev-scripts/DT-56285-.../analyze.mjs` from the repo root.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const inScriptDir = (fileName) => path.join(SCRIPT_DIR, fileName);

/**
 * Each run gets its own timestamped output folder, created at run time:
 *
 *     analyze-results-2026-10-09T18-55-12-345Z/
 *
 * A run therefore never overwrites a previous one, and the bucket files inside a
 * folder are always from a single consistent pass. mitigate.mjs picks the newest
 * such folder unless told otherwise.
 */
const RUN_STARTED_AT = new Date();
const RUN_DIR = inScriptDir(
    `analyze-results-${RUN_STARTED_AT.toISOString().replace(/[:.]/g, '-')}`
);
const inRunDir = (fileName) => path.join(RUN_DIR, fileName);

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
// Staging : http://nginx--nlbC3-hjNa0pnRoiJ7-257492ea392d9b9b.elb.ap-south-1.amazonaws.com
// PROD    : http://nginx--nlbC3-sn7vKMsxDDMK-3360319dfff3cca3.elb.eu-west-1.amazonaws.com
const BASE_URL = 'http://nginx--nlbC3-sn7vKMsxDDMK-3360319dfff3cca3.elb.eu-west-1.amazonaws.com';
const REQUEST_ID = 'DT-56285-validated-claim-analyze-script';
const CONCURRENCY = 20;
const PROGRESS_EVERY = 100;
const BATCH_DELAY_MS = 150;

const REQUEST_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/**
 * The single source of truth for the population: 1036 claims.
 *
 * Despite the filename, every row in this file HAS progress evidence — it is the
 * output of the main query with the progressEvidence guard applied. Its sibling
 * (claim_items_with_progress_evidence.json) is the same 1036 rows, verified
 * identical field-for-field, plus one extra: the legacy placeholder
 * ClaimItem@b4afd72c-bc1d-4b4b-a36b-e7c775c221d1, which is VALIDATED with a
 * COMPLETED workflow by construction and must never be patched.
 *
 * Only this file is read. The sibling is deliberately NOT a fallback — silently
 * picking it up would pull that legacy row back into scope.
 */
const INPUT_CANDIDATES = ['test.json'];

// The three statuses this defect can have destroyed. A claim demoted from anything
// else is not this bug and must not be auto-repaired.
const RECOVERABLE_STATUSES = new Set([
    'VERIFIED_APPROVED',
    'VERIFIED_REJECTED',
    'UNABLE_TO_VERIFY',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT
// ═══════════════════════════════════════════════════════════════════════════════

function parseInputOverride() {
    const idx = process.argv.indexOf('--input');
    if (idx === -1) return null;

    const value = process.argv[idx + 1];
    if (!value || value.startsWith('--')) {
        console.error('--input needs a filename, e.g. --input test.json');
        process.exit(1);
    }
    return path.basename(value);
}

/**
 * Normalises the several JSON shapes this input plausibly arrives in into a flat
 * array of row objects.
 *
 * Accepted:
 *   [{ claimItemId, ... }, ...]            rows, the normal shape
 *   ["ClaimItem@...", ...]                 bare ID strings
 *   { items|rows|data|entities: [...] }    wrapped array
 *   {...}\n{...}\n                         newline-delimited JSON
 */
function parseInputDocument(raw) {
    const text = raw.trim();
    if (!text) return [];

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Fall back to NDJSON: one JSON value per line.
        const rows = [];
        for (const line of text.split('\n')) {
            const trimmed = line.trim().replace(/,$/, '');
            if (!trimmed) continue;
            try {
                rows.push(JSON.parse(trimmed));
            } catch {
                return null; // not JSON at all
            }
        }
        return rows;
    }

    if (Array.isArray(parsed)) return parsed;

    for (const key of ['items', 'rows', 'data', 'entities', 'results', 'claimItems']) {
        if (Array.isArray(parsed?.[key])) return parsed[key];
    }

    return null;
}

function toRow(entry) {
    if (typeof entry === 'string') {
        return { claimItemId: entry.trim() };
    }
    if (entry && typeof entry === 'object') {
        const claimItemId = (entry.claimItemId ?? entry.id ?? '').toString().trim();
        return claimItemId ? { ...entry, claimItemId } : null;
    }
    return null;
}

/**
 * Returns { rows, inputFile }. The filename is carried out so the run summary can
 * record which input a given results folder was produced from.
 *
 * `--input <file>` overrides the default, which is how test.json gets used for a
 * small trial run without editing the script.
 */
function loadClaimRows() {
    const explicit = parseInputOverride();
    const candidates = explicit ? [explicit] : INPUT_CANDIDATES;

    for (const fileName of candidates) {
        const inputFile = inScriptDir(fileName);

        let raw;
        try {
            raw = fs.readFileSync(inputFile, 'utf-8');
        } catch {
            continue;
        }

        const entries = parseInputDocument(raw);
        if (entries === null) {
            console.error(`  ${fileName} is not valid JSON, skipping`);
            continue;
        }

        const rows = [];
        const seen = new Set();
        let skippedNoId = 0;

        for (const entry of entries) {
            const row = toRow(entry);
            if (!row) {
                skippedNoId++;
                continue;
            }
            if (seen.has(row.claimItemId)) continue;
            seen.add(row.claimItemId);
            rows.push(row);
        }

        if (rows.length === 0) {
            console.error(`  ${fileName} yielded no rows with a claimItemId, skipping`);
            continue;
        }

        console.log(`  Loaded ${rows.length} unique claim IDs from ${fileName}`);
        if (skippedNoId > 0) {
            console.log(`  Skipped ${skippedNoId} entries with no claimItemId`);
        }
        return { rows, inputFile };
    }

    console.error(`No input JSON found in ${SCRIPT_DIR}`);
    console.error(`Looked for: ${candidates.join(', ')}`);
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP
// ═══════════════════════════════════════════════════════════════════════════════

const headers = {
    'Content-Type': 'application/json',
    'x-request-id': REQUEST_ID,
};

/**
 * Carries which of the three reads failed, plus the HTTP status and response body.
 *
 * Without this the bucket just said "timeout of 20000ms exceeded" against a claim
 * id, which does not say whether the claim, the audit trail or the component call
 * broke — so there was nothing to act on.
 */
class StepError extends Error {
    constructor(step, cause) {
        const status = cause?.response?.status ?? null;
        super(`${step}: ${status ? `HTTP ${status}` : cause?.message ?? 'unknown error'}`);
        this.name = 'StepError';
        this.step = step;
        this.httpStatus = status;
        this.responseBody = cause?.response?.data
            ? JSON.stringify(cause.response.data).slice(0, 500)
            : null;
        this.cause = cause;
    }
}

function isRetryable(error) {
    if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') return true;
    const status = error?.response?.status;
    return status === 429 || (typeof status === 'number' && status >= 500);
}

/**
 * Retries transient failures (timeouts, 429, 5xx) with linear backoff.
 *
 * The first run put all five test claims into fetchErrors on timeouts and 500s.
 * A single attempt per claim makes a momentary blip look like a data problem.
 */
async function withRetry(step, operation) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt === MAX_ATTEMPTS || !isRetryable(error)) break;
            await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * attempt));
        }
    }

    throw new StepError(step, lastError);
}

// Product routes wrap their payload in a DFGResponse, so `entities` is the normal
// shape. The other keys are tolerated so a route that returns a bare list or a
// nested envelope still parses.
function extractItems(payload) {
    return (
        payload?.entities ??
        payload?.data?.entities ??
        payload?.items ??
        payload?.data?.items ??
        []
    );
}

/**
 * Claim item, from its owning service.
 *
 * GET /claim-items/:id -> ClaimItemController.fetchClaimItemById
 *
 * forDeletedAlso / forDetachedAlso / forCancelledAlso are deliberately left off.
 * Their default (false) means a claim that has since been deleted, detached or
 * cancelled will NOT come back as a normal record — it lands in fetchErrors
 * instead, which is the outcome we want. Those claims must not be patched.
 */
async function fetchClaimItem(claimItemId) {
    const url = `${BASE_URL}/verification-request/claim-items/${encodeURIComponent(claimItemId)}`;
    return withRetry('fetchClaimItem', async () => {
        const res = await axios.get(url, { headers, timeout: REQUEST_TIMEOUT_MS });
        return extractItems(res.data)[0] ?? null;
    });
}

/**
 * Component, from its owning service.
 *
 * GET /components/:id -> ComponentController.getComponentById
 */
async function fetchComponent(componentId) {
    const url = `${BASE_URL}/core-verification-data-structure-service/components/${encodeURIComponent(componentId)}`;
    return withRetry('fetchComponent', async () => {
        const res = await axios.get(url, { headers, timeout: REQUEST_TIMEOUT_MS });
        return extractItems(res.data)[0] ?? null;
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

function buildBaseRecord(inputRow, claim) {
    return {
        claimItemId: claim.id,
        caseId: inputRow.caseId || null,
        claimWorkflowId: inputRow.claimWorkflowId || null,
        componentId: claim.componentId ?? null,
        componentTypeId: claim.componentTypeId ?? null,
        verificationRequestId: claim.verificationRequestId ?? null,
        isVerificationRequired: claim.isVerificationRequired ?? null,
        liveClaimStatus: claim.claimStatus ?? null,
        claimUpdatedAt: claim.updatedAt ?? null,
        progressEvidence: inputRow.progressEvidence || null,
    };
}

async function classifyClaim(inputRow) {
    const claimItemId = inputRow.claimItemId;

    const claim = await fetchClaimItem(claimItemId);
    if (!claim) {
        return { bucket: 'fetchErrors', record: { claimItemId, error: 'CLAIM_NOT_FOUND' } };
    }

    const base = buildBaseRecord(inputRow, claim);

    // Guard 1: the Report Transfer with Past Case flow creates these already at
    // VALIDATED with a COMPLETED workflow, by construction. Nothing was lost.
    if (claim.legacy === true) {
        return {
            bucket: 'excludedLegacy',
            record: { ...base, reason: 'legacy=true, VALIDATED at creation, no terminal status to restore' },
        };
    }

    // Guard 2: the snapshot is up to 6h stale and claims do self-repair.
    if (claim.claimStatus !== 'VALIDATED') {
        return {
            bucket: 'alreadyRepaired',
            record: { ...base, reason: `live claimStatus is ${claim.claimStatus}, not VALIDATED` },
        };
    }

    if (!claim.componentId) {
        return {
            bucket: 'needsManualReview',
            record: { ...base, reason: 'claim has no componentId, so no recovery value exists' },
        };
    }

    const component = await fetchComponent(claim.componentId);
    const componentStatus = component?.componentStatus ?? null;

    const enriched = { ...base, componentStatus, recoveredClaimStatus: componentStatus };

    if (!component) {
        return {
            bucket: 'needsManualReview',
            record: { ...enriched, reason: `component ${claim.componentId} not found` },
        };
    }

    // The component must itself hold a terminal status. ComponentStatus has no
    // VALIDATED member — its non-terminal values are DRAFT and UNDER_REVIEW — so
    // anything outside the recoverable three means verification never completed
    // and there is nothing to restore.
    if (!componentStatus || !RECOVERABLE_STATUSES.has(componentStatus)) {
        return {
            bucket: 'needsManualReview',
            record: {
                ...enriched,
                reason: `componentStatus is ${componentStatus ?? 'absent'}, not a terminal status — nothing to restore`,
            },
        };
    }

    return {
        bucket: 'readyToMitigate',
        record: {
            ...enriched,
            source: `componentStatus=${componentStatus}, mirrored from claimStatus by determineTargetComponentStatus at verification time`,
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    const { rows: inputRows, inputFile } = loadClaimRows();

    console.log('='.repeat(72));
    console.log('  DT-56285: VALIDATED claim with COMPLETED workflow - ANALYZE');
    console.log('  READ-ONLY. No writes.');
    console.log(`  Input           : ${path.basename(inputFile)}`);
    console.log(`  Claims to check : ${inputRows.length}`);
    console.log(`  Concurrency     : ${CONCURRENCY}`);
    console.log(`  Target          : ${BASE_URL}`);
    console.log(`  Output folder   : ${path.basename(RUN_DIR)}/`);
    console.log('='.repeat(72));

    const buckets = {
        readyToMitigate: [],
        needsManualReview: [],
        alreadyRepaired: [],
        excludedLegacy: [],
        fetchErrors: [],
    };

    let processed = 0;
    const startTime = Date.now();

    for (let i = 0; i < inputRows.length; i += CONCURRENCY) {
        const batch = inputRows.slice(i, i + CONCURRENCY);

        const results = await Promise.allSettled(batch.map((row) => classifyClaim(row)));

        results.forEach((result, j) => {
            if (result.status === 'rejected') {
                const error = result.reason;
                buckets.fetchErrors.push({
                    claimItemId: batch[j].claimItemId,
                    failedStep: error?.step ?? 'unknown',
                    httpStatus: error?.httpStatus ?? null,
                    error: error?.message ?? 'Unknown error',
                    responseBody: error?.responseBody ?? null,
                });
                return;
            }
            buckets[result.value.bucket].push(result.value.record);
        });

        processed += batch.length;

        if (processed % PROGRESS_EVERY < CONCURRENCY || processed === inputRows.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const pct = Math.round((processed / inputRows.length) * 100);
            console.log(
                `  [${processed}/${inputRows.length}] ${pct}% (${elapsed}s) | ` +
                    `ready: ${buckets.readyToMitigate.length} | ` +
                    `review: ${buckets.needsManualReview.length} | ` +

                    `repaired: ${buckets.alreadyRepaired.length} | ` +
                    `legacy: ${buckets.excludedLegacy.length} | ` +
                    `errors: ${buckets.fetchErrors.length}`
            );
        }

        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n' + '='.repeat(72));
    console.log(`RESULTS (completed in ${elapsed}s)`);
    console.log('='.repeat(72));
    console.log(`  ready-to-mitigate    ${String(buckets.readyToMitigate.length).padStart(6)}   componentStatus is terminal`);
    console.log(`  needs-manual-review  ${String(buckets.needsManualReview.length).padStart(6)}   component non-terminal, missing, or absent`);
    console.log(`  already-repaired     ${String(buckets.alreadyRepaired.length).padStart(6)}   no longer VALIDATED live`);
    console.log(`  excluded-legacy      ${String(buckets.excludedLegacy.length).padStart(6)}   legacy=true placeholders`);
    console.log(`  fetch-errors         ${String(buckets.fetchErrors.length).padStart(6)}   re-runnable`);
    console.log('='.repeat(72));

    // Which call broke, not just that something broke.
    if (buckets.fetchErrors.length > 0) {
        const byStep = {};
        for (const row of buckets.fetchErrors) {
            const key = `${row.failedStep}${row.httpStatus ? ` (HTTP ${row.httpStatus})` : ' (timeout/network)'}`;
            byStep[key] = (byStep[key] ?? 0) + 1;
        }
        console.log('\nFailures by step:');
        for (const [step, count] of Object.entries(byStep)) {
            console.log(`  ${String(count).padStart(5)}  ${step}`);
        }
    }

    const recoveryBreakdown = {};
    for (const record of buckets.readyToMitigate) {
        const status = record.recoveredClaimStatus;
        recoveryBreakdown[status] = (recoveryBreakdown[status] ?? 0) + 1;
    }
    if (Object.keys(recoveryBreakdown).length > 0) {
        console.log('\nRecovery values in ready-to-mitigate:');
        for (const [status, count] of Object.entries(recoveryBreakdown)) {
            console.log(`  ${status.padEnd(20)} ${count}`);
        }
    }

    const fileByBucket = {
        readyToMitigate: 'ready-to-mitigate.json',
        needsManualReview: 'needs-manual-review.json',
        alreadyRepaired: 'already-repaired.json',
        excludedLegacy: 'excluded-legacy.json',
        fetchErrors: 'fetch-errors.json',
    };

    fs.mkdirSync(RUN_DIR, { recursive: true });

    for (const [bucket, fileName] of Object.entries(fileByBucket)) {
        fs.writeFileSync(inRunDir(fileName), JSON.stringify(buckets[bucket], null, 2));
    }

    // A manifest so a folder is self-describing months later: which input it came
    // from, when, against what, and the bucket counts without opening six files.
    fs.writeFileSync(
        inRunDir('run-summary.json'),
        JSON.stringify(
            {
                startedAt: RUN_STARTED_AT.toISOString(),
                finishedAt: new Date().toISOString(),
                durationSeconds: Number(elapsed),
                inputFile: path.basename(inputFile),
                baseUrl: BASE_URL,
                requestId: REQUEST_ID,
                claimsChecked: inputRows.length,
                counts: Object.fromEntries(
                    Object.entries(buckets).map(([name, rows]) => [name, rows.length])
                ),
                recoveryValueBreakdown: recoveryBreakdown,
            },
            null,
            2
        )
    );

    console.log(`\nWrote ${path.basename(RUN_DIR)}/`);
    console.log('  ' + [...Object.values(fileByBucket), 'run-summary.json'].join(', '));

    if (buckets.readyToMitigate.length > 0) {
        console.log(`\nNext: review ${path.basename(RUN_DIR)}/ready-to-mitigate.json, then`);
        console.log('  node mitigate.mjs                      # dry run, newest run folder');
        console.log('  node mitigate.mjs --execute --limit 5  # first real batch');
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
