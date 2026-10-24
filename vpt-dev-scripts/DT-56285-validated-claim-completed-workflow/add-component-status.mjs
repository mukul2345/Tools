/**
 * DT-56285: Enrich the split JSON buckets with each claim's live componentStatus.
 *
 * READ-ONLY against prod. Point reads only — GET /components/:id by exact id, no
 * scans, no writes.
 *
 * Why componentStatus matters here: ComponentService.determineTargetComponentStatus
 * derives componentStatus FROM claimStatus and throws INVALID_CLAIM_ITEM_STATUS_TO_VERIFY
 * for any non-terminal claimStatus. So the component holds the last persisted mirror of
 * the terminal claimStatus the claim had before it was demoted — including any
 * accreditation adjustment. It is therefore the recovery value, and also the test for
 * whether a claim is recoverable at all:
 *
 *   componentStatus VERIFIED_APPROVED / VERIFIED_REJECTED / UNABLE_TO_VERIFY
 *       -> recoverable, patch claimStatus back to that value
 *   componentStatus DRAFT / UNDER_REVIEW
 *       -> verification never completed, nothing to restore, NOT this defect
 *
 * Input:  input-files/split/<claimStatus>__<currentStage>.json
 * Output: input-files/split-with-component-status/<same filename>.json
 *         every original field preserved, plus componentStatus and the derived
 *         recoverability fields. Plus _summary.json with a claimStatus x
 *         componentStatus cross-tab, which is the actually useful artifact.
 *
 * Usage:
 *   node add-component-status.mjs                              # all split files
 *   node add-component-status.mjs VALIDATED__COMPLETED.json    # one bucket
 *   node add-component-status.mjs --limit 20                   # first 20 rows per file
 *   node add-component-status.mjs --resume                     # skip rows already enriched
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.join(SCRIPT_DIR, 'input-files', 'split');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'input-files', 'split-with-component-status');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
// Staging : http://nginx--nlbC3-hjNa0pnRoiJ7-257492ea392d9b9b.elb.ap-south-1.amazonaws.com
// PROD    : http://nginx--nlbC3-sn7vKMsxDDMK-3360319dfff3cca3.elb.eu-west-1.amazonaws.com
const BASE_URL = 'http://nginx--nlbC3-sn7vKMsxDDMK-3360319dfff3cca3.elb.eu-west-1.amazonaws.com';
const REQUEST_ID = 'DT-56285-add-component-status';

const CONCURRENCY = 20;
const BATCH_DELAY_MS = 150;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const PROGRESS_EVERY = 100;

// The three statuses a verified claim can hold. ComponentStatus uses the identical
// strings, so the mapping back to claimStatus is the identity.
const RECOVERABLE_STATUSES = new Set([
    'VERIFIED_APPROVED',
    'VERIFIED_REJECTED',
    'UNABLE_TO_VERIFY',
]);

const RESUME = process.argv.includes('--resume');

function parseLimit() {
    const idx = process.argv.indexOf('--limit');
    if (idx === -1) return null;
    const value = Number(process.argv[idx + 1]);
    if (!Number.isInteger(value) || value <= 0) {
        console.error('--limit needs a positive integer, e.g. --limit 20');
        process.exit(1);
    }
    return value;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP
// ═══════════════════════════════════════════════════════════════════════════════

const headers = {
    'Content-Type': 'application/json',
    'x-request-id': REQUEST_ID,
};

function extractItems(payload) {
    return (
        payload?.entities ??
        payload?.data?.entities ??
        payload?.items ??
        payload?.data?.items ??
        []
    );
}

function describeError(error) {
    const status = error?.response?.status;
    if (status) return `HTTP ${status}`;
    return error?.code ?? error?.message ?? 'unknown error';
}

function isRetryable(error) {
    if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') return true;
    const status = error?.response?.status;
    return status === 429 || (typeof status === 'number' && status >= 500);
}

/**
 * Component, from its owning service.
 * GET /components/:id -> ComponentController.getComponentById
 */
async function fetchComponent(componentId) {
    const url = `${BASE_URL}/core-verification-data-structure-service/components/${encodeURIComponent(componentId)}`;
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await axios.get(url, { headers, timeout: REQUEST_TIMEOUT_MS });
            return { component: extractItems(res.data)[0] ?? null, error: null };
        } catch (error) {
            lastError = error;
            if (attempt === MAX_ATTEMPTS || !isRetryable(error)) break;
            await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * attempt));
        }
    }

    return { component: null, error: describeError(lastError) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENRICHMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns the original row plus component fields. Nothing is removed or renamed —
 * these files are meant to be a superset of the split files, so they can be diffed
 * against them.
 */
function enrich(row, component, fetchError) {
    const componentStatus = component?.componentStatus ?? null;
    const isRecoverable = componentStatus !== null && RECOVERABLE_STATUSES.has(componentStatus);

    return {
        ...row,
        componentStatus,
        componentStatusFetchedAt: new Date().toISOString(),
        // Only populated when the component holds a terminal status. Null means
        // "do not patch this claim" rather than "patch it to null".
        recoveredClaimStatus: isRecoverable ? componentStatus : null,
        isRecoverable,
        recoverabilityReason: buildReason(row, componentStatus, fetchError, isRecoverable),
        componentFetchError: fetchError,
    };
}

function buildReason(row, componentStatus, fetchError, isRecoverable) {
    if (!row.componentId) return 'claim has no componentId';
    if (fetchError) return `component fetch failed: ${fetchError}`;
    if (componentStatus === null) return 'component not found or has no componentStatus';
    if (isRecoverable) return `componentStatus ${componentStatus} is terminal — recoverable`;
    return `componentStatus ${componentStatus} is not terminal — verification never completed`;
}

/**
 * Verifies the one assumption this script relies on: componentId is 1:1 with
 * claimItemId, so every row needs exactly one fetch and there is nothing to dedupe.
 *
 * Checked rather than assumed. A duplicate would only cost a redundant call, so it
 * warns rather than exits; a missing componentId is reported because those rows
 * cannot be enriched at all.
 */
function preflight(allRows) {
    const seen = new Map();
    let missing = 0;

    for (const row of allRows) {
        if (!row.componentId) {
            missing++;
            continue;
        }
        seen.set(row.componentId, (seen.get(row.componentId) ?? 0) + 1);
    }

    const duplicated = [...seen.entries()].filter(([, n]) => n > 1);

    return {
        rows: allRows.length,
        uniqueComponentIds: seen.size,
        missingComponentId: missing,
        duplicatedComponentIds: duplicated.map(([id, n]) => ({ componentId: id, rows: n })),
    };
}

function loadAlreadyEnriched(fileName) {
    if (!RESUME) return new Map();

    const outPath = path.join(OUTPUT_DIR, fileName);
    if (!fs.existsSync(outPath)) return new Map();

    try {
        const rows = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        const done = new Map();
        for (const row of rows) {
            // Only treat a row as done if it actually resolved. Rows that errored
            // are retried, which is the point of --resume.
            if (row.componentStatus !== null && !row.componentFetchError) {
                done.set(row.claimItemId, row);
            }
        }
        return done;
    } catch {
        return new Map();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function enrichFile(fileName, limit) {
    const rows = JSON.parse(fs.readFileSync(path.join(INPUT_DIR, fileName), 'utf-8'));
    const scoped = limit === null ? rows : rows.slice(0, limit);
    const alreadyDone = loadAlreadyEnriched(fileName);

    const enriched = [];
    let processed = 0;
    let reused = 0;
    const startTime = Date.now();

    for (let i = 0; i < scoped.length; i += CONCURRENCY) {
        const batch = scoped.slice(i, i + CONCURRENCY);

        const results = await Promise.all(
            batch.map(async (row) => {
                const done = alreadyDone.get(row.claimItemId);
                if (done) {
                    reused++;
                    return done;
                }
                if (!row.componentId) return enrich(row, null, null);
                const { component, error } = await fetchComponent(row.componentId);
                return enrich(row, component, error);
            })
        );

        enriched.push(...results);
        processed += batch.length;

        if (processed % PROGRESS_EVERY < CONCURRENCY || processed === scoped.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const recoverable = enriched.filter((r) => r.isRecoverable).length;
            console.log(
                `    [${processed}/${scoped.length}] ${elapsed}s | recoverable: ${recoverable}` +
                    (reused > 0 ? ` | reused: ${reused}` : '')
            );
        }

        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    fs.writeFileSync(
        path.join(OUTPUT_DIR, fileName),
        JSON.stringify(enriched, null, 2)
    );

    return enriched;
}

async function main() {
    if (!fs.existsSync(INPUT_DIR)) {
        console.error(`Not found: ${INPUT_DIR}`);
        console.error('Run split-by-status.mjs first.');
        process.exit(1);
    }

    const named = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
    const candidates = named.length
        ? named.map((arg) => path.basename(arg))
        : fs
              .readdirSync(INPUT_DIR)
              .filter((f) => f.endsWith('.json') && f !== '_summary.json')
              .sort();

    const missing = candidates.filter((f) => !fs.existsSync(path.join(INPUT_DIR, f)));
    if (missing.length > 0) {
        console.error(`Not found in ${INPUT_DIR}: ${missing.join(', ')}`);
        process.exit(1);
    }

    const limit = parseLimit();
    const allRows = candidates.flatMap((f) =>
        JSON.parse(fs.readFileSync(path.join(INPUT_DIR, f), 'utf-8'))
    );
    const checks = preflight(allRows);
    const plannedReads =
        limit === null
            ? checks.rows - checks.missingComponentId
            : Math.min(checks.rows, limit * candidates.length);

    console.log('='.repeat(72));
    console.log('  DT-56285: add componentStatus to the split buckets');
    console.log('  READ-ONLY. Point reads by component id. No writes, no scans.');
    console.log(`  Files           : ${candidates.length}`);
    console.log(`  Rows            : ${checks.rows}${limit !== null ? ` (limited to ${limit}/file)` : ''}`);
    console.log(`  componentIds    : ${checks.uniqueComponentIds} unique, 1:1 with rows`);
    console.log(`  Prod GETs       : ${plannedReads}`);
    console.log(`  Concurrency     : ${CONCURRENCY}`);
    console.log(`  Target          : ${BASE_URL}`);
    console.log(`  Resume          : ${RESUME ? 'on — already-resolved rows reused' : 'off'}`);
    console.log('='.repeat(72));

    if (checks.missingComponentId > 0) {
        console.log(`\n  ${checks.missingComponentId} rows have no componentId — they will be marked not recoverable.`);
    }
    if (checks.duplicatedComponentIds.length > 0) {
        console.log(
            `\n  NOTE: ${checks.duplicatedComponentIds.length} componentIds appear on more than one row,` +
                ' so those will be fetched more than once. Correct, just slightly wasteful.'
        );
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const summary = [];
    const overallCrossTab = {};

    for (const fileName of candidates) {
        console.log(`\n  ${fileName}`);
        const enriched = await enrichFile(fileName, limit);

        const byComponentStatus = {};
        for (const row of enriched) {
            const key = row.componentStatus ?? (row.componentFetchError ? 'FETCH_ERROR' : 'ABSENT');
            byComponentStatus[key] = (byComponentStatus[key] ?? 0) + 1;

            const claimStatus = row.claimStatus;
            overallCrossTab[claimStatus] = overallCrossTab[claimStatus] ?? {};
            overallCrossTab[claimStatus][key] = (overallCrossTab[claimStatus][key] ?? 0) + 1;
        }

        summary.push({
            file: fileName,
            claimStatus: enriched[0]?.claimStatus ?? null,
            currentStage: enriched[0]?.currentStage ?? null,
            claims: enriched.length,
            recoverable: enriched.filter((r) => r.isRecoverable).length,
            notRecoverable: enriched.filter((r) => !r.isRecoverable).length,
            byComponentStatus,
            recoveryValues: enriched.reduce((acc, r) => {
                if (r.recoveredClaimStatus) {
                    acc[r.recoveredClaimStatus] = (acc[r.recoveredClaimStatus] ?? 0) + 1;
                }
                return acc;
            }, {}),
        });
    }

    fs.writeFileSync(
        path.join(OUTPUT_DIR, '_summary.json'),
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                baseUrl: BASE_URL,
                requestId: REQUEST_ID,
                limit,
                resume: RESUME,
                preflight: checks,
                claimStatusVsComponentStatus: overallCrossTab,
                buckets: summary,
            },
            null,
            2
        )
    );

    const grandTotal = summary.reduce((s, b) => s + b.claims, 0);
    const grandRecoverable = summary.reduce((s, b) => s + b.recoverable, 0);

    console.log('\n' + '='.repeat(72));
    console.log('SUMMARY — claimStatus x componentStatus');
    console.log('='.repeat(72));
    for (const [claimStatus, counts] of Object.entries(overallCrossTab)) {
        console.log(`  ${claimStatus}`);
        for (const [componentStatus, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
            const marker = RECOVERABLE_STATUSES.has(componentStatus) ? 'recoverable' : '';
            console.log(`    ${String(count).padStart(5)}  ${componentStatus.padEnd(20)} ${marker}`);
        }
    }
    console.log('='.repeat(72));
    console.log(`  ${grandRecoverable} of ${grandTotal} recoverable`);
    console.log(`\nWrote ${path.relative(SCRIPT_DIR, OUTPUT_DIR)}/ (${candidates.length} files + _summary.json)`);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
