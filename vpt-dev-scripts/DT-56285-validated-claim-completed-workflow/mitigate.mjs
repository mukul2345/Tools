/**
 * DT-56285: Re-run verification on claims whose terminal claimStatus was lost.
 *
 * The mitigation does NOT patch claimStatus directly. It calls the product's own
 * endpoint and lets that derive the correct status:
 *
 *     PATCH /claim-items/verify-claim/:id      body {}
 *
 * which is exactly the call the engine makes
 * (VerificationRequestServiceClient.verifyClaim ->
 *  ClaimItemController.verifyClaimItem -> ClaimItemService.verifyClaimItem ->
 *  VerifyClaimProcessor.process()).
 *
 * Doing it this way means the status is computed by the same code that computes it
 * normally — including the NON_PSV path, accreditation adjustment, and
 * clientClaimStatus — rather than by this script guessing. We supply no status at
 * all, so there is nothing for us to get wrong.
 *
 * ONE INPUT FILE PER RUN, passed as an argument. With no argument the script does
 * nothing and exits non-zero; there is no default and no "all files" mode, because
 * a mistyped command must never fan out across 1452 claims.
 *
 * Results: results/<input-file-name>-<timestamp>.json
 *
 * Usage:
 *   node mitigate.mjs                                              # does NOTHING, prints usage
 *   node mitigate.mjs VALIDATED__COMPLETED.json                    # DRY RUN
 *   node mitigate.mjs VALIDATED__COMPLETED.json --limit 5          # DRY RUN, first 5
 *   node mitigate.mjs VALIDATED__COMPLETED.json --execute --limit 5 # LIVE, first 5
 *   node mitigate.mjs VALIDATED__COMPLETED.json --execute          # LIVE, whole file
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.join(SCRIPT_DIR, 'input-files', 'split-with-component-status');
const RESULTS_DIR = path.join(SCRIPT_DIR, 'results');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
// Staging : http://nginx--nlbC3-hjNa0pnRoiJ7-257492ea392d9b9b.elb.ap-south-1.amazonaws.com
// PROD    : http://nginx--nlbC3-sn7vKMsxDDMK-3360319dfff3cca3.elb.eu-west-1.amazonaws.com
const BASE_URL = 'http://nginx--nlbC3-sn7vKMsxDDMK-3360319dfff3cca3.elb.eu-west-1.amazonaws.com';
const REQUEST_ID = 'DT-56285-verify-claim-mitigation';

// Deliberately low. This is a production mutation; throughput is worth nothing.
const CONCURRENCY = 5;
const BATCH_DELAY_MS = 300;
const REQUEST_TIMEOUT_MS = 30000;

const TERMINAL_STATUSES = new Set([
    'VERIFIED_APPROVED',
    'VERIFIED_REJECTED',
    'UNABLE_TO_VERIFY',
]);

// Statuses verify-claim will reject outright. This set must stay in lockstep with
// VerifyClaimProcessor.validate(), which throws INVALID_CLAIM_STATUS for exactly
// these four. A claim that never reached validation has no verification response to
// derive a terminal status from, so calling verify-claim on it only produces errors.
const NOT_VERIFIABLE_STATUSES = new Set([
    'DRAFT',
    'READY',
    'READY_WITH_IA',
    'CANCELLED',
]);

const LIVE_MODE = process.argv.includes('--execute');

// ═══════════════════════════════════════════════════════════════════════════════
// ARGUMENTS
// ═══════════════════════════════════════════════════════════════════════════════

function usage(reason) {
    if (reason) console.error(`\n${reason}\n`);
    console.error('Usage: node mitigate.mjs <input-file.json> [--execute] [--limit N]');
    console.error('');
    console.error('  <input-file.json>  REQUIRED. A file in input-files/split-with-component-status/');
    console.error('  --execute          perform the verify-claim calls. Omit for a dry run.');
    console.error('  --limit N          only process the first N claims.');
    console.error('');
    console.error('Available input files:');
    try {
        fs.readdirSync(INPUT_DIR)
            .filter((f) => f.endsWith('.json') && f !== '_summary.json')
            .sort()
            .forEach((f) => {
                const n = JSON.parse(fs.readFileSync(path.join(INPUT_DIR, f), 'utf-8')).length;
                console.error(`  ${String(n).padStart(5)}  ${f}`);
            });
    } catch {
        console.error(`  (none — ${INPUT_DIR} not readable)`);
    }
    process.exit(1);
}

function parseLimit() {
    const idx = process.argv.indexOf('--limit');
    if (idx === -1) return null;
    const value = Number(process.argv[idx + 1]);
    if (!Number.isInteger(value) || value <= 0) {
        usage('--limit needs a positive integer, e.g. --limit 5');
    }
    return value;
}

/**
 * Resolves the single input file. No argument is a hard stop — not a default, not
 * "everything". That is the main guard against an accidental mass run.
 */
function resolveInputFile() {
    const positional = process.argv.slice(2).filter((arg) => {
        if (arg.startsWith('--')) return false;
        // Drop the value that belongs to --limit
        const prevIdx = process.argv.indexOf(arg) - 1;
        return process.argv[prevIdx] !== '--limit';
    });

    if (positional.length === 0) {
        usage('No input file given. Nothing was run.');
    }
    if (positional.length > 1) {
        usage(`Exactly one input file per run. Got: ${positional.join(', ')}`);
    }

    const fileName = path.basename(positional[0]);
    const fullPath = path.join(INPUT_DIR, fileName);

    if (!fs.existsSync(fullPath)) {
        usage(`Not found: ${fullPath}`);
    }

    return { fileName, fullPath };
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
    return {
        message: error?.response?.status
            ? `HTTP ${error.response.status}`
            : error?.code ?? error?.message ?? 'unknown error',
        httpStatus: error?.response?.status ?? null,
        body: error?.response?.data ? JSON.stringify(error.response.data).slice(0, 600) : null,
    };
}

async function fetchClaimItem(claimItemId) {
    const url = `${BASE_URL}/verification-request/claim-items/${encodeURIComponent(claimItemId)}`;
    const res = await axios.get(url, { headers, timeout: REQUEST_TIMEOUT_MS });
    return extractItems(res.data)[0] ?? null;
}

/**
 * The mitigation call. Empty body — the service derives everything itself.
 *
 * Not retried on purpose. verify-claim is idempotent (it recomputes from the
 * claim's existing verification responses), so the recovery path for a failure is
 * simply to re-run the script, which re-reads live state first. An automatic retry
 * would only obscure which attempt actually landed.
 */
async function verifyClaim(claimItemId) {
    const url = `${BASE_URL}/verification-request/claim-items/verify-claim/${encodeURIComponent(claimItemId)}`;
    const res = await axios.patch(url, {}, { headers, timeout: REQUEST_TIMEOUT_MS });
    return extractItems(res.data)[0] ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PER-CLAIM PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Re-validates against live state immediately before acting. The enriched input may
 * be hours old, and claims do self-repair.
 */
function checkEligibility(row, liveClaim) {
    if (!liveClaim) {
        return { eligible: false, skipReason: 'CLAIM_NOT_FOUND' };
    }
    if (liveClaim.legacy === true) {
        return { eligible: false, skipReason: 'LEGACY_CLAIM' };
    }
    if (TERMINAL_STATUSES.has(liveClaim.claimStatus)) {
        return {
            eligible: false,
            skipReason: `ALREADY_TERMINAL (${liveClaim.claimStatus})`,
        };
    }
    if (NOT_VERIFIABLE_STATUSES.has(liveClaim.claimStatus)) {
        return {
            eligible: false,
            skipReason: `NOT_VERIFIABLE (verify-claim rejects ${liveClaim.claimStatus})`,
        };
    }
    if (!row.isRecoverable) {
        return {
            eligible: false,
            skipReason: `COMPONENT_NOT_TERMINAL (componentStatus ${row.componentStatus ?? 'absent'})`,
        };
    }
    return { eligible: true, skipReason: null };
}

async function processClaim(row) {
    const outcome = {
        claimItemId: row.claimItemId,
        caseId: row.caseId,
        claimWorkflowId: row.claimWorkflowId,
        componentId: row.componentId,
        componentTypeId: row.componentTypeId,
        verificationRequestId: row.verificationRequestId,
        currentStage: row.currentStage,
        claimStatusInInputFile: row.claimStatus,
        componentStatus: row.componentStatus ?? null,
        expectedClaimStatus: row.recoveredClaimStatus ?? null,
        claimStatusBefore: null,
        claimStatusAfter: null,
        matchedExpected: null,
        skipReason: null,
        error: null,
        attemptedAt: null,
    };

    let liveClaim;
    try {
        liveClaim = await fetchClaimItem(row.claimItemId);
    } catch (error) {
        outcome.error = describeError(error);
        outcome.skipReason = 'PRE_READ_FAILED';
        return { status: 'failed', outcome };
    }

    outcome.claimStatusBefore = liveClaim?.claimStatus ?? null;

    const { eligible, skipReason } = checkEligibility(row, liveClaim);
    if (!eligible) {
        outcome.skipReason = skipReason;
        return { status: 'skipped', outcome };
    }

    if (!LIVE_MODE) {
        outcome.plannedCall = `PATCH /claim-items/verify-claim/${row.claimItemId}`;
        return { status: 'wouldVerify', outcome };
    }

    outcome.attemptedAt = new Date().toISOString();

    try {
        const updated = await verifyClaim(row.claimItemId);
        outcome.claimStatusAfter = updated?.claimStatus ?? null;
        outcome.matchedExpected =
            outcome.expectedClaimStatus === null
                ? null
                : outcome.claimStatusAfter === outcome.expectedClaimStatus;

        // A 200 that left the status non-terminal is not a success. Surfaced so it
        // cannot hide inside the verified count.
        if (!TERMINAL_STATUSES.has(outcome.claimStatusAfter)) {
            return { status: 'verifiedButNotTerminal', outcome };
        }
        return { status: 'verified', outcome };
    } catch (error) {
        outcome.error = describeError(error);
        return { status: 'failed', outcome };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    const { fileName, fullPath } = resolveInputFile();
    const limit = parseLimit();

    const allRows = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    const rows = limit === null ? allRows : allRows.slice(0, limit);

    const eligibleByInput = rows.filter((r) => r.isRecoverable).length;

    console.log('='.repeat(72));
    console.log('  DT-56285: re-verify claims via PATCH /claim-items/verify-claim/:id');
    console.log(`  Mode            : ${LIVE_MODE ? 'LIVE — WILL MUTATE PRODUCTION' : 'DRY RUN — no mutation'}`);
    console.log(`  Input file      : ${fileName}`);
    console.log(`  Claims in file  : ${allRows.length}${limit !== null ? ` (limited to ${rows.length})` : ''}`);
    console.log(`  Recoverable     : ${eligibleByInput} by componentStatus in the input file`);
    console.log(`  Concurrency     : ${CONCURRENCY}`);
    console.log(`  Target          : ${BASE_URL}`);
    console.log('  Per claim       : 1 GET (pre-read) then 1 PATCH verify-claim');
    console.log('  No claimStatus is sent — the service derives it.');
    console.log('='.repeat(72));

    if (!LIVE_MODE) {
        console.log('\n  DRY RUN. Pass --execute to perform the verify-claim calls.\n');
    }

    if (rows.length === 0) {
        console.log('Nothing to do.');
        return;
    }

    const results = {
        verified: [],
        verifiedButNotTerminal: [],
        wouldVerify: [],
        skipped: [],
        failed: [],
    };

    let processed = 0;
    const startedAt = new Date();

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
        const batch = rows.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(batch.map((row) => processClaim(row)));

        settled.forEach((result, j) => {
            if (result.status === 'rejected') {
                results.failed.push({
                    claimItemId: batch[j].claimItemId,
                    error: { message: result.reason?.message ?? 'Unknown error' },
                });
                return;
            }
            results[result.value.status].push(result.value.outcome);
        });

        processed += batch.length;
        const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
        console.log(
            `  [${processed}/${rows.length}] ${elapsed}s | ` +
                (LIVE_MODE
                    ? `verified: ${results.verified.length} | not-terminal: ${results.verifiedButNotTerminal.length}`
                    : `would verify: ${results.wouldVerify.length}`) +
                ` | skipped: ${results.skipped.length} | failed: ${results.failed.length}`
        );

        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    console.log('\n' + '='.repeat(72));
    console.log('SUMMARY');
    console.log('='.repeat(72));
    if (LIVE_MODE) {
        console.log(`  verified (now terminal)   ${String(results.verified.length).padStart(6)}`);
        console.log(`  verified but NOT terminal ${String(results.verifiedButNotTerminal.length).padStart(6)}   <- inspect these`);
    } else {
        console.log(`  would verify              ${String(results.wouldVerify.length).padStart(6)}`);
    }
    console.log(`  skipped                   ${String(results.skipped.length).padStart(6)}`);
    console.log(`  failed                    ${String(results.failed.length).padStart(6)}`);
    console.log('='.repeat(72));

    const skipReasons = {};
    for (const row of results.skipped) {
        skipReasons[row.skipReason] = (skipReasons[row.skipReason] ?? 0) + 1;
    }
    if (Object.keys(skipReasons).length > 0) {
        console.log('\nSkip reasons:');
        for (const [reason, count] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${String(count).padStart(5)}  ${reason}`);
        }
    }

    if (LIVE_MODE && results.verified.length > 0) {
        const transitions = {};
        for (const row of results.verified) {
            const key = `${row.claimStatusBefore} -> ${row.claimStatusAfter}`;
            transitions[key] = (transitions[key] ?? 0) + 1;
        }
        console.log('\nStatus transitions:');
        for (const [t, count] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${String(count).padStart(5)}  ${t}`);
        }

        const mismatched = results.verified.filter((r) => r.matchedExpected === false);
        if (mismatched.length > 0) {
            console.log(
                `\n  ${mismatched.length} claims ended on a status differing from componentStatus.` +
                    ' Not necessarily wrong — the service may have applied an accreditation' +
                    ' adjustment — but worth reading in the results file.'
            );
        }
    }

    if (!LIVE_MODE && results.wouldVerify.length > 0) {
        console.log('\nFirst few planned calls:');
        for (const row of results.wouldVerify.slice(0, 5)) {
            console.log(`  ${row.claimItemId}`);
            console.log(`      ${row.claimStatusBefore} -> expected ${row.expectedClaimStatus} (case ${row.caseId})`);
        }
    }

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const timestamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const outName = `${fileName.replace(/\.json$/i, '')}-${timestamp}${LIVE_MODE ? '_LIVE' : '_DRYRUN'}.json`;

    fs.writeFileSync(
        path.join(RESULTS_DIR, outName),
        JSON.stringify(
            {
                mode: LIVE_MODE ? 'LIVE' : 'DRY_RUN',
                inputFile: fileName,
                startedAt: startedAt.toISOString(),
                finishedAt: new Date().toISOString(),
                baseUrl: BASE_URL,
                requestId: REQUEST_ID,
                endpoint: 'PATCH /claim-items/verify-claim/:id',
                limit,
                claimsInFile: allRows.length,
                claimsProcessed: rows.length,
                counts: {
                    verified: results.verified.length,
                    verifiedButNotTerminal: results.verifiedButNotTerminal.length,
                    wouldVerify: results.wouldVerify.length,
                    skipped: results.skipped.length,
                    failed: results.failed.length,
                },
                skipReasons,
                ...results,
            },
            null,
            2
        )
    );

    console.log(`\nWrote results/${outName}`);

    if (results.failed.length > 0) {
        console.log(
            `\n${results.failed.length} failed. Re-running is safe: verify-claim is idempotent and` +
                ' already-terminal claims are skipped as ALREADY_TERMINAL.'
        );
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
