/**
 * DT-49771: Soft-Delete Dangerous RT ReVerification Invocations
 *
 * Reads not-deleted.json (output of analyze.mjs), for each record:
 * 1. Fetches the workflow using newWorkflowId
 * 2. Checks if workflow has: state=DELETED, status=COMPLETED, currentStage=COMPLETED, isDeleted=true
 * 3. Only if ALL conditions match → soft-delete the invocation
 *
 * Outputs:
 *   - eligible-for-delete.json   (workflow is deleted, will be cleaned up)
 *   - not-eligible.json          (workflow is NOT deleted, legit in-progress RT)
 *   - cleanup-results-<ts>.json  (actual deletion results when --execute is used)
 *
 * Usage:
 *   node cleanup.mjs              # DRY RUN (checks workflows, categorizes, no deletions)
 *   node cleanup.mjs --execute    # LIVE (checks + soft-deletes eligible ones)
 */

import fs from 'fs';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
// Staging : http://nginx--nlbC3-hjNa0pnRoiJ7-257492ea392d9b9b.elb.ap-south-1.amazonaws.com
// PROD:    http://nginx--nlbC3-sn7vKMsxDDMK-3360319dfff3cca3.elb.eu-west-1.amazonaws.com
const BASE_URL = 'http://nginx--nlbC3-hjNa0pnRoiJ7-257492ea392d9b9b.elb.ap-south-1.amazonaws.com';
const REQUEST_ID = 'DT-49771-RT-invocation-cleanup';
const CONCURRENCY = 50;
const PROGRESS_EVERY = 1000;
const LIVE_MODE = process.argv.includes('--execute');

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP
// ═══════════════════════════════════════════════════════════════════════════════

const headers = {
    'Content-Type': 'application/json',
    'x-request-id': REQUEST_ID,
};

async function fetchWorkflowById(workflowId) {
    const url = `${BASE_URL}/verification-workflow-engine/workflow/${workflowId}?force=ALL`;
    const res = await axios.get(url, { headers, timeout: 15000 });
    const data = res.data;
    const entities = data?.entities || data?.data?.entities || [];
    return entities[0] || data?.data || data || null;
}

async function deleteInvocation(invocationId) {
    const url = `${BASE_URL}/verification-request/reVerificationInvocation/${invocationId}`;
    const res = await axios.delete(url, { headers, timeout: 15000 });
    return res.data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKFLOW CHECK
// ═══════════════════════════════════════════════════════════════════════════════

function isWorkflowDeleted(workflow) {
    if (!workflow) return false;
    return (
        workflow.state === 'CANCELLED' &&
        workflow.status === 'COMPLETED' &&
        workflow.currentStage === 'COMPLETED'
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    let records;
    try {
        const data = fs.readFileSync('./not-deleted.json', 'utf-8');
        records = JSON.parse(data);
    } catch {
        console.error('❌ not-deleted.json not found. Run analyze.mjs first.');
        process.exit(1);
    }

    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  DT-49771: RT ReVerification Invocation - CLEANUP                   ║');
    console.log(`║  Mode: ${LIVE_MODE ? '⚡ LIVE (check + soft-delete)' : '🔍 DRY RUN (check workflows only)'}                        ║`);
    console.log(`║  Records to process: ${String(records.length).padEnd(47)}║`);
    console.log(`║  Concurrency: ${CONCURRENCY} parallel requests                               ║`);
    console.log('╚══════════════════════════════════════════════════════════════════════╝');

    if (!LIVE_MODE) {
        console.log('\n  ℹ️  Dry run mode. Checking workflows only. Pass --execute to also soft-delete.\n');
    }

    if (records.length === 0) {
        console.log('\n✅ No records to process.');
        return;
    }

    const eligible = [];       // workflow is DELETED → safe to delete invocation
    const notEligible = [];    // workflow is NOT deleted → legit, leave alone
    const workflowErrors = []; // couldn't fetch workflow
    let deleted = 0;
    let deleteErrors = 0;
    let processed = 0;
    const startTime = Date.now();

    // Phase 1: Check workflows in batches
    console.log('\n── Phase 1: Checking workflows ──\n');

    for (let i = 0; i < records.length; i += CONCURRENCY) {
        const batch = records.slice(i, i + CONCURRENCY);

        const results = await Promise.allSettled(
            batch.map(async (record) => {
                const workflow = await fetchWorkflowById(record.newWorkflowId);
                return { record, workflow };
            })
        );

        for (let j = 0; j < results.length; j++) {
            const result = results[j];
            const record = batch[j];

            if (result.status === 'rejected') {
                workflowErrors.push({
                    ...record,
                    workflowError: result.reason?.message || 'Unknown error',
                });
            } else {
                const { workflow } = result.value;
                if (isWorkflowDeleted(workflow)) {
                    eligible.push({
                        ...record,
                        workflowState: workflow?.state,
                        workflowStatus: workflow?.status,
                        workflowCurrentStage: workflow?.currentStage,
                        workflowIsDeleted: workflow?.isDeleted,
                    });
                } else {
                    notEligible.push({
                        ...record,
                        workflowState: workflow?.state,
                        workflowStatus: workflow?.status,
                        workflowCurrentStage: workflow?.currentStage,
                        workflowIsDeleted: workflow?.isDeleted,
                    });
                }
            }
        }

        processed += batch.length;

        if (processed % PROGRESS_EVERY < CONCURRENCY || processed === records.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const pct = Math.round((processed / records.length) * 100);
            console.log(`  [${processed}/${records.length}] ${pct}% (${elapsed}s) | Eligible: ${eligible.length} | Not eligible: ${notEligible.length} | Errors: ${workflowErrors.length}`);
        }

        await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Write categorized outputs
    fs.writeFileSync('./eligible-for-delete.json', JSON.stringify(eligible, null, 2));
    fs.writeFileSync('./not-eligible.json', JSON.stringify(notEligible, null, 2));
    if (workflowErrors.length > 0) {
        fs.writeFileSync('./workflow-check-errors.json', JSON.stringify(workflowErrors, null, 2));
    }

    console.log('\n── Phase 1 Results ──');
    console.log(`  🚨 Eligible for delete (workflow DELETED):  ${eligible.length}`);
    console.log(`  🟢 Not eligible (workflow active/other):    ${notEligible.length}`);
    console.log(`  ❌ Workflow fetch errors:                   ${workflowErrors.length}`);

    // Phase 2: Delete eligible records (only in LIVE mode)
    if (LIVE_MODE && eligible.length > 0) {
        console.log(`\n── Phase 2: Soft-deleting ${eligible.length} eligible records ──\n`);

        const deleteResults = [];
        let deleteProcessed = 0;

        for (let i = 0; i < eligible.length; i += CONCURRENCY) {
            const batch = eligible.slice(i, i + CONCURRENCY);

            const results = await Promise.allSettled(
                batch.map(record => deleteInvocation(record.id).then(() => ({ id: record.id, status: 'DELETED' })))
            );

            for (let j = 0; j < results.length; j++) {
                const result = results[j];
                const id = batch[j].id;

                if (result.status === 'rejected') {
                    deleteErrors++;
                    deleteResults.push({ id, status: 'ERROR', error: result.reason?.message || 'Unknown' });
                } else {
                    deleted++;
                    deleteResults.push(result.value);
                }
            }

            deleteProcessed += batch.length;

            if (deleteProcessed % PROGRESS_EVERY < CONCURRENCY || deleteProcessed === eligible.length) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                const pct = Math.round((deleteProcessed / eligible.length) * 100);
                console.log(`  [${deleteProcessed}/${eligible.length}] ${pct}% (${elapsed}s) | Deleted: ${deleted} | Errors: ${deleteErrors}`);
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(`./cleanup-results-${timestamp}.json`, JSON.stringify(deleteResults, null, 2));

        console.log('\n── Phase 2 Results ──');
        console.log(`  ✅ Soft-deleted:  ${deleted}`);
        console.log(`  ❌ Delete errors: ${deleteErrors}`);
    } else if (!LIVE_MODE && eligible.length > 0) {
        console.log(`\n  ℹ️  ${eligible.length} records eligible for deletion.`);
        console.log('  Run: node cleanup.mjs --execute   to soft-delete them.');
    }

    // Final summary
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n═══ Done in ${totalElapsed}s ═══`);
    console.log('\nOutput files:');
    console.log('  - eligible-for-delete.json       ← Workflow is DELETED, safe to clean');
    console.log('  - not-eligible.json              ← Workflow active, leave alone');
    if (workflowErrors.length > 0) console.log('  - workflow-check-errors.json     ← Could not fetch workflow');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
