/**
 * DT-49771: Analyze RT ReVerification Invocations
 *
 * Reads invocation IDs from Athena CSV/JSON output, fetches each via API,
 * and separates into:
 *   - already-deleted.json   (isDeleted=true → safe, no action needed)
 *   - not-deleted.json       (isDeleted absent/false → dangerous, need cleanup)
 *
 * Usage:
 *   node analyze.mjs
 *
 * Input: Place CSV or JSON in this directory.
 */

import fs from 'fs';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
// Staging : http://nginx--nlbC3-hjNa0pnRoiJ7-257492ea392d9b9b.elb.ap-south-1.amazonaws.com
// PROD:    http://nginx--nlbC3-sn7vKMsxDDMK-3360319dfff3cca3.elb.eu-west-1.amazonaws.com
const BASE_URL = 'http://nginx--nlbC3-hjNa0pnRoiJ7-257492ea392d9b9b.elb.ap-south-1.amazonaws.com';
const REQUEST_ID = 'DT-49771-RT-invocation-analyze';
const CONCURRENCY = 50;
const PROGRESS_EVERY = 1000;

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD IDS
// ═══════════════════════════════════════════════════════════════════════════════

function loadInvocationIds() {
    // Try JSON first
    try {
        const data = fs.readFileSync('./invocation-ids.json', 'utf-8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) return parsed;
        return parsed.ids || parsed.data || [];
    } catch { /* not found */ }

    // Try CSV (multiple filenames)
    const csvCandidates = [
        './ReverificationInvocation_REPORT_TRANSFER_IN_PROGRESS.csv',
    ];

    // const csvCandidates = [
    //     './Staging_Reverification.csv'    
    // ];

    for (const csvFile of csvCandidates) {
        try {
            const data = fs.readFileSync(csvFile, 'utf-8');
            const lines = data.trim().split('\n');

            const firstLine = lines[0].trim();
            const hasHeader = firstLine.toLowerCase().includes('id') || !firstLine.startsWith('ReVerificationInvocationData@');
            const startIdx = hasHeader ? 1 : 0;
            const ids = [];

            for (let i = startIdx; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                const columns = line.split(',');
                const idCol = columns.find(col => col.includes('ReVerificationInvocationData@'));
                if (idCol) {
                    ids.push(idCol.replace(/"/g, '').trim());
                } else if (columns[0].trim()) {
                    ids.push(columns[0].replace(/"/g, '').trim());
                }
            }

            if (ids.length > 0) {
                console.log(`  Loaded ${ids.length} IDs from ${csvFile}`);
                return ids;
            }
        } catch { /* try next */ }
    }

    console.error('❌ No input file found. Place invocation-ids.json or invocation-ids.csv or the Athena CSV in this directory.');
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP
// ═══════════════════════════════════════════════════════════════════════════════

const headers = {
    'Content-Type': 'application/json',
    'x-request-id': REQUEST_ID,
};

async function fetchInvocationById(invocationId) {
    const url = `${BASE_URL}/verification-request/reVerificationInvocation/${invocationId}`;
    const res = await axios.get(url, { headers, timeout: 15000 });
    const data = res.data;
    const entities = data?.entities || data?.data?.entities || [];
    return entities[0] || data?.data || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    const invocationIds = loadInvocationIds();

    const estMinutes = Math.ceil((invocationIds.length / CONCURRENCY) * 0.12 / 60);
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  DT-49771: RT ReVerification Invocation - ANALYZE                   ║');
    console.log(`║  Records to check: ${String(invocationIds.length).padEnd(49)}║`);
    console.log(`║  Concurrency: ${CONCURRENCY} parallel requests                               ║`);
    console.log(`║  Estimated time: ~${String(estMinutes).padEnd(3)} minutes                                        ║`);
    console.log('╚══════════════════════════════════════════════════════════════════════╝');

    if (invocationIds.length === 0) {
        console.log('\n❌ No invocation IDs loaded.');
        process.exit(1);
    }

    const alreadyDeleted = [];
    const notDeleted = [];
    const fetchErrors = [];
    let processed = 0;
    const startTime = Date.now();

    // Process in concurrent batches of CONCURRENCY
    for (let i = 0; i < invocationIds.length; i += CONCURRENCY) {
        const batch = invocationIds.slice(i, i + CONCURRENCY);

        const results = await Promise.allSettled(
            batch.map(id => fetchInvocationById(id).then(record => ({ id, record })))
        );

        for (let j = 0; j < results.length; j++) {
            const result = results[j];
            const id = batch[j];

            if (result.status === 'rejected') {
                fetchErrors.push({ id, error: result.reason?.message || 'Unknown error' });
            } else {
                const { record } = result.value;
                if (!record) {
                    fetchErrors.push({ id, error: 'NOT_FOUND' });
                } else if (record.isDeleted === true) {
                    alreadyDeleted.push({
                        id: record.id || id,
                        existingWorkflowId: record.existingWorkflowId,
                        newWorkflowId: record.newWorkflowId,
                        invocationStatus: record.invocationStatus,
                        updatedAt: record.updatedAt,
                    });
                } else {
                    notDeleted.push({
                        id: record.id || id,
                        existingWorkflowId: record.existingWorkflowId,
                        newWorkflowId: record.newWorkflowId,
                        invocationStatus: record.invocationStatus,
                        createdAt: record.createdAt,
                        updatedAt: record.updatedAt,
                    });
                }
            }
        }

        processed += batch.length;

        if (processed % PROGRESS_EVERY < CONCURRENCY || processed === invocationIds.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const pct = Math.round((processed / invocationIds.length) * 100);
            console.log(`  [${processed}/${invocationIds.length}] ${pct}% (${elapsed}s) | Deleted: ${alreadyDeleted.length} | Not deleted: ${notDeleted.length} | Errors: ${fetchErrors.length}`);
        }

        // 100ms delay between batches
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Write outputs
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n' + '═'.repeat(70));
    console.log(`RESULTS (completed in ${elapsed}s)`);
    console.log('═'.repeat(70));
    console.log(`  ✅ Already deleted (safe):     ${alreadyDeleted.length}`);
    console.log(`  🚨 Not deleted (dangerous):    ${notDeleted.length}`);
    console.log(`  ❌ Fetch errors:               ${fetchErrors.length}`);
    console.log('═'.repeat(70));

    fs.writeFileSync('./already-deleted.json', JSON.stringify(alreadyDeleted, null, 2));
    fs.writeFileSync('./not-deleted.json', JSON.stringify(notDeleted, null, 2));
    if (fetchErrors.length > 0) {
        fs.writeFileSync('./fetch-errors.json', JSON.stringify(fetchErrors, null, 2));
    }

    console.log('\nOutput files:');
    console.log('  - already-deleted.json   ← Safe, no action needed');
    console.log('  - not-deleted.json       ← DANGEROUS, run cleanup.mjs to soft-delete');
    if (fetchErrors.length > 0) console.log('  - fetch-errors.json      ← Retry these later');

    if (notDeleted.length > 0) {
        console.log(`\n⚠️  ${notDeleted.length} records need cleanup!`);
        console.log('   Run: node cleanup.mjs');
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
