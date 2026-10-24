# DT-49771: RT ReVerification Invocation Cleanup

## Problem

When a VR (Verification Request) is deleted via the DELETE API, the associated `ReVerificationInvocationData` records are NOT cleaned up (the `cleanupReVerificationInvocations` function doesn't exist in the delete flow). This leaves orphaned records with:
- `invocationStatus: IN_PROGRESS`
- `verificationType: REPORT_TRANSFER`
- `isDeleted: false` (or absent)

These records cause `checkForOngoingPaidRTWithReVerification` to return `hasOngoingPaidRT: true`, blocking new RT component creation for the parent case.

## Root Cause (DT-49771)

The DELETE API (`deleteVerificationRequestById`) marks:
- VR: `isDeleted: true`
- Claim items: `isDeleted: true`
- Workflow engine (async via SQS): `state: DELETED`, `isDeleted: true`, `currentStage: COMPLETED`

But it does NOT touch `ReVerificationInvocationData`. The cancel API does (marks `invocationStatus: ORIGINAL_WORKFLOW_PROCESSED`), but DELETE doesn't.

## Code Fix

A guard was added in `checkForOngoingPaidRTWithReVerification` to check if the VR workflow is deleted before considering the invocation as blocking. However, existing stale records still need cleanup.

## Usage

### Phase 1: Analysis

```bash
# Place your Athena query output as invocation-ids.csv or invocation-ids.json
node index.mjs
```

This produces categorized output files showing which records are dangerous.

### Phase 2: Cleanup

```bash
# After reviewing not-deleted-vr-deleted.json
node index.mjs --cleanup
```

This soft-deletes (sets `isDeleted: true`) on all dangerous records.

## Athena Query

```sql
SELECT id, invocationstatus, verificationtype, existingworkflowid, newworkflowid, createdat, updatedat
FROM "default"."reverificationinvocationdata"
WHERE verificationtype = 'REPORT_TRANSFER'
  AND invocationstatus = 'IN_PROGRESS'
ORDER BY createdat DESC;
```

Note: `isDeleted` column is not available in Athena schema, so we must fetch each record via API to check.

## Input Format

**invocation-ids.csv:**
```
id
ReVerificationInvocationData@xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ReVerificationInvocationData@yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy
```

**invocation-ids.json:**
```json
[
  "ReVerificationInvocationData@xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "ReVerificationInvocationData@yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"
]
```

## Output Categories

| File | Meaning | Action |
|------|---------|--------|
| `already-deleted.json` | `isDeleted=true` already set | No action needed |
| `not-deleted-vr-deleted.json` | VR workflow is DELETED but invocation lingers | **DANGEROUS** - run cleanup |
| `not-deleted-vr-active.json` | VR workflow is active/in-progress | Legit, leave alone |
| `not-deleted-vr-completed.json` | VR completed, invocation stale | Low priority cleanup |
| `not-deleted-vr-unknown.json` | Couldn't determine VR state | Investigate manually |
| `fetch-errors.json` | API errors | Retry later |

## Environment

- Staging: `http://nginx--nlbC3-hjNa0pnRoiJ7-257492ea392d9b9b.elb.ap-south-1.amazonaws.com`
- Production: `http://nginx--nlbC3-sn7vKMsxDDMK-3360319dfff3cca3.elb.eu-west-1.amazonaws.com`

Change `BASE_URL` in `index.mjs` to target the correct environment.
