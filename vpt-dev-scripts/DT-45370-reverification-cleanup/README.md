# DT-45370: Reverification Invocation Cleanup Script

## Purpose

Corrects parent workflows stuck in `COMPLETED/RE_VERIFICATION` due to orphaned `ReVerificationInvocationData` records left behind after EC/Appeal cancellation via the "SOP TO CANCEL CASE".

## Prerequisites

- Node.js 18+
- `axios` (installed via `npm install`)
- Network access to the NLB endpoint

## Setup

1. Populate `vr-ids.json` with the list of cancelled EC/Appeal VR IDs from the spreadsheet
2. Review `DRY_RUN` setting in `index.mjs` (defaults to `true`)
3. Set `BASE_URL` to the correct environment (staging or prod NLB)

## Usage

```bash
cd dev-toolbox/DT-45370-reverification-cleanup
npm install
node index.mjs
```

To run live (execute mutations): edit `index.mjs` and set `DRY_RUN = false`.

## Logic Flow Per VR

```
VR ID
  → Step 1: Fetch workflow by resourceEntityId (newWorkflowId)
  → Step 2: Query ReVerificationInvocationData by newWorkflowId
      → Get existingWorkflowId (parentWorkflowId)
      → Get originalWorkflowResourceEntityStatus
      → Check if parent invocations already deleted
  → Step 3: Fetch child claim workflows of newWorkflowId
      → If no children AND parent invocations deleted → SKIP
  → Step 4: For each child workflow, fetch ReVerificationInvocationData
  → Step 5: Delete all non-deleted invocations (parent + child)
      → If parent invocations were already deleted → SKIPPED_NEXT_STEPS
         (child invocations still get deleted, but workflow/VR patch is skipped)
  → Step 6: PATCH parent workflow → status/stage/state = COMPLETED
  → Step 7: Get parent VR ID from parent workflow, revert verificationStatus
```

## Output

### Files Generated

Each run produces two files:

- `results-<timestamp>.json` — full structured results
- `results-<timestamp>.csv` — tabular report for tracking

### CSV Columns

| Column | Description |
| --- | --- |
| VR_ID | The cancelled EC/Appeal VR being processed |
| Status | Outcome status (see below) |
| Reason | Why it was skipped or errored |
| NewWorkflowId | The cancelled VR's workflow ID |
| ParentWorkflowId | The existingWorkflowId (parent stuck in RE_VERIFICATION) |
| ParentVrId | The parent VR whose status was reverted |
| OriginalStatus | The verificationStatus reverted to |
| ParentInvocationsDeleted | Count of parent invocations deleted |
| ParentInvocationIds | Semicolon-separated IDs of deleted parent invocations |
| ChildInvocationsDeleted | Count of child invocations deleted |
| ChildInvocationIds | Semicolon-separated IDs of deleted child invocations |
| Timestamp | When it was processed |

### Status Values

| Status | Meaning |
| --- | --- |
| `COMPLETED` | Fully processed — invocations deleted, workflow patched, VR status reverted |
| `SKIPPED` | No action needed — invocations already deleted or no workflow found |
| `SKIPPED_NEXT_STEPS` | Parent invocations were already deleted; child invocations deleted but workflow/VR patch skipped |
| `ERROR` | Something failed during processing |

## Safety

- **DRY_RUN mode**: Default behavior, logs all actions without executing mutations
- **Rate limited**: 500ms delay between VRs
- **Idempotent skipping**: If parent invocations are already deleted, workflow/VR updates are skipped
- **Results logged**: Every execution produces timestamped JSON + CSV results files
- **Non-destructive**: Invocation deletion is soft-delete (sets `isDeleted: true`)

## Environment URLs

```javascript
// Staging
http://nginx--nlbC3-hjNa0pnRoiJ7-257492ea392d9b9b.elb.ap-south-1.amazonaws.com

// Production
http://nginx--nlbC3-sn7vKMsxDDMK-3360319dfff3cca3.elb.eu-west-1.amazonaws.com
```