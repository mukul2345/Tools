/**
 * DT-45370: Reverification Invocation Cleanup Script
 *
 * Corrects workflows that were cancelled via "SOP TO CANCEL CASE" but left
 * ReVerificationInvocationData records orphaned, causing infinite re-enqueue loops.
 *
 * Steps per VR:
 * 1. Fetch VR → get workflow (newWorkflowId)
 * 2. Query ReVerificationInvocationData by newWorkflowId → get existingWorkflowId (parent)
 * 3. Fetch child claim workflows of the VR
 * 4. For all workflows (VR + claims), query invocations by newWorkflowId
 * 5. Delete invocation records (if not already deleted)
 *    - If ALL are already deleted → skip to next VR
 *    - If SOME are deleted and some not → delete remaining, but skip steps 6-7
 *    - If NONE are deleted → delete all, then proceed to steps 6-7
 * 6. PATCH parent workflow → status/stage/state = COMPLETED
 * 7. PATCH parent VR → revert verificationStatus to originalWorkflowResourceEntityStatus
 *
 * Usage:
 *   node index.mjs
 *
 * Config: Edit the VR_IDS array below or load from a CSV/JSON file.
 */

import fs from 'fs';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
// Staging : http://nginx--nlbC3-hjNa0pnRoiJ7-257492ea392d9b9b.elb.ap-south-1.amazonaws.com
// PROD: http://nginx--nlbC3-sn7vKMsxDDMK-3360319dfff3cca3.elb.eu-west-1.amazonaws.com
const BASE_URL = 'http://nginx--nlbC3-hjNa0pnRoiJ7-257492ea392d9b9b.elb.ap-south-1.amazonaws.com';
const REQUEST_ID = 'DT-45370-dev-mitigation';
const DRY_RUN = false; // Set to false to actually execute mutations

// List of cancelled EC/Appeal VR IDs to process
// Load from file or paste inline
const VR_IDS = loadVrIds();

function loadVrIds() {
    // Try loading from a file first
    try {
        const data = fs.readFileSync('./vr-ids.json', 'utf-8');
        return JSON.parse(data);
    } catch {
        // Fallback: paste IDs here
        return [
            // 'VerificationRequest@xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        ];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const headers = {
    'Content-Type': 'application/json',
    'x-request-id': REQUEST_ID,
};

async function httpGet(url) {
    const res = await axios.get(url, { headers });
    return res.data;
}

async function httpPatch(url, body) {
    if (DRY_RUN) {
        console.log(`  [DRY_RUN] PATCH ${url}`, JSON.stringify(body));
        return { dryRun: true };
    }
    const res = await axios.patch(url, body, { headers });
    return res.data;
}

async function httpDelete(url) {
    if (DRY_RUN) {
        console.log(`  [DRY_RUN] DELETE ${url}`);
        return { dryRun: true };
    }
    const res = await axios.delete(url, { headers });
    return res.data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// API CALLS
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchWorkflowByResourceEntityId(resourceEntityId) {
    const url = `${BASE_URL}/verification-workflow-engine/workflow?resourceEntityId=${encodeURIComponent(resourceEntityId)}&force=ALL`;
    const response = await httpGet(url);
    const entities = response?.entities || response?.data?.entities || [];
    return entities[0] || null;
}

async function fetchWorkflowById(workflowId) {
    const url = `${BASE_URL}/verification-workflow-engine/workflow/${workflowId}?force=ALL`;
    const response = await httpGet(url);
    const entities = response?.entities || response?.data?.entities || [];
    return entities[0] || response;
}

async function getVrIdByWorkflowId(workflowId) {
    const workflow = await fetchWorkflowById(workflowId);
    return workflow?.resourceEntityId || null;
}

async function fetchChildWorkflows(parentWorkflowId) {
    const url = `${BASE_URL}/verification-workflow-engine/workflow?parentWorkflowId=${encodeURIComponent(parentWorkflowId)}&force=ALL`;
    const response = await httpGet(url);
    return response?.entities || response?.data?.entities || [];
}

async function fetchInvocationsByNewWorkflowId(newWorkflowId) {
    const url = `${BASE_URL}/verification-request/reVerificationInvocation?newWorkflowId=${encodeURIComponent(newWorkflowId)}`;
    const response = await httpGet(url);
    return response?.entities || response?.data?.entities || [];
}

async function deleteInvocation(invocationId) {
    const url = `${BASE_URL}/verification-request/reVerificationInvocation/${invocationId}`;
    return httpDelete(url);
}

async function patchWorkflow(workflowId, body) {
    const url = `${BASE_URL}/verification-workflow-engine/workflow/${workflowId}`;
    return httpPatch(url, body);
}

async function patchVerificationRequest(vrId, body) {
    const url = `${BASE_URL}/verification-request/verification-request/${vrId}`;
    return httpPatch(url, body);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

async function processVR(vrId) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`Processing VR: ${vrId}`);
    console.log(`${'═'.repeat(80)}`);

    // Step 1: Find the workflow for this VR (this is the newWorkflowId)
    const vrWorkflow = await fetchWorkflowByResourceEntityId(vrId);
    if (!vrWorkflow?.id) {
        console.log(`⚠️  No workflow found for VR ${vrId}. Skipping.`);
        return { vrId, status: 'SKIPPED', reason: 'No workflow found' };
    }
    const newWorkflowId = vrWorkflow.id;
    console.log(`VR Workflow (newWorkflowId) = ${newWorkflowId}`);

    // Step 2: Query invocation by newWorkflowId to find existingWorkflowId (parent)
    const parentReverificationInvocationData = await fetchInvocationsByNewWorkflowId(newWorkflowId);
    const parentWorkflowId = parentReverificationInvocationData.map(data => {
        return data.existingWorkflowId
    })
    if (!parentReverificationInvocationData?.length) {
        console.log(`  ⚠️  No ReVerificationInvocationData found for newWorkflowId=${newWorkflowId}. Skipping.`);
        // return { vrId, status: 'SKIPPED', reason: 'No invocation data found' };
    }

    const parentReverificationInvocationsDeleted = parentReverificationInvocationData.every(inv => inv.isDeleted === true);
    const parentReverificationInvocationDataId = parentReverificationInvocationData.map(data => {
        if(!data?.isDeleted){
            return data.id
        }
    })

    //Step 3: Get all child worklfows
    const childworkflowsOfNewWorkflow = await fetchChildWorkflows(newWorkflowId)
    const childWorkflowsOfNewWorkflowIds = childworkflowsOfNewWorkflow.map(cw => cw.id);

    if(!childworkflowsOfNewWorkflow?.length){
        console.log(`  ⚠️  No child workflows found for newWorkflowId=${newWorkflowId}. Skipping.`);
        if(parentReverificationInvocationsDeleted){
            console.log(`  ⚠️  ReVerificationInvocationData already deleted for newWorkflowId=${newWorkflowId}. Skipping to next VR.`);
            return { vrId, status: 'SKIPPED', reason: 'ReVerificationInvocationData already deleted and no child workflow id exists' };
        }
    }

    let childReverificationInvocationDataIds = []

    for(let i = 0; i < childWorkflowsOfNewWorkflowIds.length; i++){
        try {
            const childReverificationInvocationData = await fetchInvocationsByNewWorkflowId(childWorkflowsOfNewWorkflowIds[i]);
            const cRIIds = childReverificationInvocationData.map(data => data.id)
            childReverificationInvocationDataIds.push(...cRIIds)
        } catch (error) {
            console.error('Error in getting reverification invocation for child workflows ', childWorkflowsOfNewWorkflowIds[i], error.message)
        }
    }

    // deleting parent reverification invocation data
    if(parentReverificationInvocationDataId && parentReverificationInvocationDataId.length > 0){
        for(const inv of parentReverificationInvocationDataId){
            console.log(`  Deleting parent invocation: ${inv}`);
            try {
                await deleteInvocation(inv);
                console.log(`    ✅ Deleted`);
            } catch (err) {
                console.log(`    ❌ Failed to delete: ${err.message}`);
            }
        }
    }

    // deleting child reverification invocation data
    if(childReverificationInvocationDataIds && childReverificationInvocationDataIds.length > 0){
        for(const inv of childReverificationInvocationDataIds){
            console.log(`  Deleting child invocation: ${inv}`);
            try {
                await deleteInvocation(inv);
                console.log(`    ✅ Deleted`);
            } catch (err) {
                console.log(`    ❌ Failed to delete: ${err.message}`);
            }
        }
    }

    if(parentReverificationInvocationDataId.length === 0){
        console.log(`Parent is already deleted, not required to go to further steps and above we have already deleted remaining child workflow's reverification invocation data`)
        return {vrId, status: 'SKIPPED_NEXT_STEPS', reason: `Parent is already deleted, not required to go to further steps and above we have already deleted remaining child workflow's reverification invocation data`}
    }

    //patch parent workflow's status, state and stage as COMPLETED
    console.log(`Patching parent workflow ${parentWorkflowId[0]} → COMPLETED`);

    try {
        await patchWorkflow(parentWorkflowId[0], {
            status: 'COMPLETED',
            stage: 'COMPLETED',
            state: 'COMPLETED',
        });
        console.log(`    ✅ Parent workflow updated`);
    } catch (err) {
        console.log(`❌ Failed to update parent workflow: ${err.message}`);
        return { vrId, status: 'ERROR', reason: `Workflow patch failed: ${err.message}` };
    }


    const originalStatus = parentReverificationInvocationData[0].originalWorkflowResourceEntityStatus;
    console.log(`Parent Workflow (existingWorkflowId) = ${parentWorkflowId[0]}`);
    console.log(`Original VR Status = ${originalStatus}`);

    //get vr by workflow id and patch VR with original status
    let parentVrId = null
    try {
        parentVrId = await getVrIdByWorkflowId(parentWorkflowId[0])
    } catch (error) {
        console.log(`    ❌ Failed to fetch parent workflow details: ${error.message}`);
        return { vrId, status: 'ERROR', reason: `Parent workflow fetch failed: ${error.message}` };

    }

    if (parentVrId && originalStatus) {
        try {
            await patchVerificationRequest(parentVrId, {
                verificationStatus: originalStatus,
            });
        } catch (error) {
        console.log(`❌ Failed to revert parent VR status: ${error.message}`);
            return { vrId, status: 'ERROR', reason: `VR patch failed: ${error.message}` };
        }
    }

    console.log(`  ✅ VR ${vrId} fully processed.`);

    return {
        vrId,
        status: 'COMPLETED',
        newWorkflowId,
        existingWorkflowId: parentWorkflowId[0],
        parentVrId,
        originalStatus,
        parentInvocationsDeleted: parentReverificationInvocationDataId.length,
        parentInvocationIds: parentReverificationInvocationDataId,
        childInvocationsDeleted: childReverificationInvocationDataIds.length,
        childInvocationIds: childReverificationInvocationDataIds,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  DT-45370: Reverification Invocation Cleanup                        ║');
    console.log(`║  Mode: ${DRY_RUN ? 'DRY RUN (no mutations)' : '⚡ LIVE (mutations enabled)'}                          ║`);
    console.log(`║  VRs to process: ${VR_IDS.length}                                              ║`);
    console.log('╚══════════════════════════════════════════════════════════════════════╝');

    if (VR_IDS.length === 0) {
        console.log('\n❌ No VR IDs loaded. Add IDs to vr-ids.json or the VR_IDS array.');
        process.exit(1);
    }

    const results = [];
    for (let i = 0; i < VR_IDS.length; i++) {
        const vrId = VR_IDS[i];
        console.log(`\n[${i + 1}/${VR_IDS.length}]`);
        try {
            const result = await processVR(vrId);
            results.push(result);
        } catch (err) {
            console.log(`  ❌ Unexpected error processing ${vrId}: ${err.message}`);
            results.push({ vrId, status: 'ERROR', reason: err.message });
        }

        // Rate limiting - 500ms between VRs
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Summary
    console.log('\n\n' + '═'.repeat(80));
    console.log('SUMMARY');
    console.log('═'.repeat(80));

    const completed = results.filter(r => r.status === 'COMPLETED');
    const skipped = results.filter(r => r.status === 'SKIPPED');
    const skippedNextSteps = results.filter(r => r.status === 'SKIPPED_NEXT_STEPS');
    const partial = results.filter(r => r.status === 'PARTIAL_DELETE');
    const errors = results.filter(r => r.status === 'ERROR');

    console.log(`  ✅ Completed:          ${completed.length}`);
    console.log(`  ⏭️  Skipped:            ${skipped.length}`);
    console.log(`  ⏭️  Skipped Next Steps: ${skippedNextSteps.length}`);
    console.log(`  ⚠️  Partial:            ${partial.length}`);
    console.log(`  ❌ Errors:             ${errors.length}`);

    // Write results to JSON
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = `./results-${timestamp}.json`;
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`\nResults written to: ${outputFile}`);

    // Write CSV report
    const csvFile = `./results-${timestamp}.csv`;
    const csvHeader = 'VR_ID,Status,Reason,NewWorkflowId,ParentWorkflowId,ParentVrId,OriginalStatus,ParentInvocationsDeleted,ParentInvocationIds,ChildInvocationsDeleted,ChildInvocationIds,Timestamp';
    const csvRows = results.map(r => [
        r.vrId || '',
        r.status || '',
        `"${(r.reason || '').replace(/"/g, '""')}"`,
        r.newWorkflowId || '',
        r.existingWorkflowId || '',
        r.parentVrId || '',
        r.originalStatus || '',
        r.parentInvocationsDeleted ?? '',
        `"${(r.parentInvocationIds || []).join(';')}"`,
        r.childInvocationsDeleted ?? '',
        `"${(r.childInvocationIds || []).join(';')}"`,
        new Date().toISOString(),
    ].join(','));
    fs.writeFileSync(csvFile, [csvHeader, ...csvRows].join('\n'));
    console.log(`CSV report written to: ${csvFile}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
