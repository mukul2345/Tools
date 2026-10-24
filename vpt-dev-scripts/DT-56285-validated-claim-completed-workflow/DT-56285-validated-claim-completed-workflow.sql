-- DT-56285  (fix shipped in DT-53329, mitigation outstanding)
--
-- Claims sitting in a NON-TERMINAL claimStatus while their CLAIM_VERIFICATION_WORKFLOW
-- has already advanced to VERIFICATION_QC, REPORT_QC or COMPLETED.
--
-- A claim workflow only reaches any of those three stages after the claim has been
-- verified, so a non-terminal claimStatus at that point is self-contradictory. The
-- known cause is closure of a stale DRAFT validation response demoting the claim,
-- with nothing re-promoting it because nothing re-runs verifyClaim once the workflow
-- has moved past VERIFICATION.
--
-- Widened from the original predicate (claimStatus = VALIDATED + stage = COMPLETED)
-- on review: the demotion can land on any non-terminal status, not just VALIDATED,
-- and a claim flipped while still at VERIFICATION_QC or REPORT_QC is equally broken —
-- it simply has not reached COMPLETED yet.
--
-- Athena UI: data source = AwsDataCatalog, database = troubled_workflow_snapshots.
-- Tables are fully qualified anyway, so the dropdowns only need to be a valid pair.
--
-- COST: reads the Parquet snapshot in S3 only. Zero read capacity against the live
-- DynamoDB tables. Safe to run and re-run.
-- =============================================================================

WITH postVerificationClaimWorkflow AS (
    SELECT
        w.id                AS claimWorkflowId,
        w.resourceEntityId  AS claimItemId,
        w.parentWorkflowId  AS caseId,
        w.currentStage,
        w.state             AS workflowState,
        w.status            AS workflowStatus,
        w.version           AS workflowVersion,
        w.updatedAt         AS workflowUpdatedAt
    FROM troubled_workflow_snapshots.workflow w
    WHERE w.definitionName = 'CLAIM_VERIFICATION_WORKFLOW'
      -- The three stages that sit AFTER verification has produced a result.
      AND w.currentStage IN ('VERIFICATION_QC', 'REPORT_QC', 'COMPLETED')
      -- Cancelled and deleted workflows are legitimate terminal parks, not instances
      -- of this defect. This is the same exclusion list ReportQcStageTroubledWorkflow
      -- applies to CLAIM_VERIFICATION_WORKFLOW.
      AND w.state NOT IN ('CANCELLED', 'MANUALLY_CANCELLED', 'DELETED', 'CLAIM_DELETED')
),

nonTerminalClaim AS (
    SELECT
        ci.id               AS claimItemId,
        ci.claimStatus,
        ci.componentId,
        ci.componentTypeId,
        ci.verificationRequestId,
        ci.applicantId,
        ci.reasonCode,
        ci.isVerificationRequired,
        ci.isVerifiedComponentAttached,
        ci.isAdditionalComponent,
        ci.legacy,
        ci.appealCount,
        ci.createdAt        AS claimCreatedAt,
        ci.updatedAt        AS claimUpdatedAt,
        ci.updatedBy        AS claimUpdatedBy,
        COALESCE(cardinality(ci.validationResponseIds), 0)     AS validationResponseCount,
        COALESCE(cardinality(ci.verificationResponseIds), 0)   AS verificationResponseCount,
        COALESCE(cardinality(ci.verificationQcResponseIds), 0) AS verificationQcResponseCount,
        COALESCE(cardinality(ci.reportQcResponseIds), 0)       AS reportQcResponseCount,
        ci.validationResponseIds
    FROM troubled_workflow_snapshots.claimitem ci
    WHERE
        -- NON-TERMINAL claimStatus. The terminal three are the only statuses a
        -- verified claim should hold; CANCELLED and DETACHED are excluded here as
        -- cancelled/removed claims rather than as "verified".
        -- What this therefore catches: DRAFT, READY, READY_WITH_IA, VALIDATED,
        -- ISSUES, INTERNAL_ISSUES.
        ci.claimStatus NOT IN (
            'VERIFIED_APPROVED',
            'VERIFIED_REJECTED',
            'UNABLE_TO_VERIFY',
            'CANCELLED',
            'DETACHED'
        )
      AND ci.claimStatus IS NOT NULL
      -- Deleted / cancelled claims on the ClaimItem side too.
      AND (ci.isDeleted IS NULL OR ci.isDeleted = false)
      AND ci.deletedAt IS NULL
      AND ci.isDeletedAt IS NULL
      AND ci.timeOfCancellation IS NULL
      AND ci.cancellationReason IS NULL
      -- Report Transfer with Past Case creates placeholder claims already at
      -- VALIDATED with a synthetic COMPLETED workflow, by construction — they never
      -- held a terminal status, so there is nothing to restore. Drop this line to
      -- see them.
      AND (ci.legacy IS NULL OR ci.legacy = false)
),

affectedClaim AS (
    SELECT
        c.claimItemId,
        c.claimStatus,
        w.currentStage,
        w.workflowState,
        w.claimWorkflowId,
        w.caseId,
        w.workflowStatus,
        w.workflowVersion,
        c.componentId,
        c.componentTypeId,
        c.verificationRequestId,
        vr.clientReferenceNumber,
        vr.verificationStatus       AS vrVerificationStatus,
        vr.verificationType         AS vrVerificationType,
        vr.clientId,
        vr.clientContractId,
        c.applicantId,
        c.reasonCode,
        c.isVerificationRequired,
        c.isVerifiedComponentAttached,
        c.isAdditionalComponent,
        c.legacy,
        c.appealCount,
        c.validationResponseCount,
        c.verificationResponseCount,
        c.verificationQcResponseCount,
        c.reportQcResponseCount,
        c.validationResponseIds,
        -- Informational only — NOT used as a filter any more. With the stage set
        -- widened, a claim legitimately sitting at VERIFICATION_QC has no report QC
        -- response yet, so filtering on this would drop exactly the mid-pipeline
        -- rows the wider net is meant to catch.
        CASE
            WHEN c.verificationResponseCount > 0 THEN 'HAS_VERIFICATION_RESPONSE'
            WHEN c.reportQcResponseCount > 0     THEN 'REACHED_REPORT_QC'
            ELSE 'NO_PROGRESS_EVIDENCE'
        END AS progressEvidence,
        date_format(from_unixtime(c.claimUpdatedAt / 1000, 'Asia/Kolkata'),
                    '%Y-%m-%d %H:%i:%s')                 AS claimUpdatedAtIst,
        date_format(from_unixtime(w.workflowUpdatedAt / 1000, 'Asia/Kolkata'),
                    '%Y-%m-%d %H:%i:%s')                 AS workflowUpdatedAtIst,
        c.claimUpdatedBy,
        c.claimUpdatedAt,
        'Claim is in non-terminal status ' || c.claimStatus
            || ' but its claim workflow has reached ' || w.currentStage
            || '; terminal claimStatus was lost and never re-promoted' AS issue,
        'nonTerminalClaimPostVerification' AS queryName
    FROM nonTerminalClaim c
    INNER JOIN postVerificationClaimWorkflow w
        ON w.claimItemId = c.claimItemId
    LEFT JOIN troubled_workflow_snapshots.verificationrequest vr
        ON vr.id = c.verificationRequestId
)

SELECT *
FROM affectedClaim
ORDER BY currentStage, claimStatus, claimUpdatedAt DESC;


-- =============================================================================
-- TRIAGE SUMMARY  (run separately — gives the shape of the population first)
-- =============================================================================
-- Same CTEs, but counts by stage x claimStatus instead of listing rows. Worth running
-- before the detail query so you know how big each bucket is.
--
-- Replace the final SELECT above with:
--
--   SELECT
--       currentStage,
--       workflowState,
--       claimStatus,
--       progressEvidence,
--       COUNT(*) AS claims,
--       COUNT(DISTINCT caseId) AS cases
--   FROM affectedClaim
--   GROUP BY currentStage, workflowState, claimStatus, progressEvidence
--   ORDER BY claims DESC;


-- =============================================================================
-- WHAT CHANGED FROM THE ORIGINAL PREDICATE
-- =============================================================================
-- Before:  claimStatus = 'VALIDATED'
--          AND currentStage = 'COMPLETED' AND state = 'COMPLETED'
--          AND progressEvidence <> 'NO_PROGRESS_EVIDENCE'
--
-- Now:     claimStatus NOT IN (terminal three + CANCELLED + DETACHED)
--          AND currentStage IN ('VERIFICATION_QC', 'REPORT_QC', 'COMPLETED')
--          AND state NOT IN ('CANCELLED','MANUALLY_CANCELLED','DELETED','CLAIM_DELETED')
--
-- Four consequences worth knowing before you run it:
--
-- 1. The result set will be LARGER, and some of the increase is expected rather than
--    defective. A claim can be legitimately non-terminal at VERIFICATION_QC while QC
--    is still in flight. Treat currentStage as a triage axis: COMPLETED rows are
--    unambiguous, VERIFICATION_QC rows need a second look.
--
-- 2. `state = 'COMPLETED'` is gone, replaced by a NOT IN exclusion. The original
--    needed the positive check because stage COMPLETED alone also covers
--    CANCELLED / CLAIM_DELETED. Now that stage is a set, the exclusion list is the
--    correct shape and also covers MANUALLY_CANCELLED, which the old version missed.
--
-- 3. progressEvidence is no longer a filter, only a column. See the comment above it.
--
-- 4. DRAFT and READY claims now qualify. A claim at DRAFT with a COMPLETED workflow is
--    a much stranger record than a VALIDATED one and may be a different defect
--    entirely (or a migration artifact). Check the claimStatus breakdown in the
--    triage summary before assuming they are all the same bug.
--
-- Deliberately NOT filtered on:
--   - componentTypeId. The defect is type-agnostic; it hit both a PSV claim (license)
--     and a NON_PSV claim (nameChange) in the same request on S003-260814-7FF6A.
--   - isVerificationRequired. Left in the output so you can eyeball it rather than
--     silently dropping rows.


-- =============================================================================
-- SNAPSHOT STALENESS
-- =============================================================================
-- troubled_workflow_snapshots.* is materialised from a DynamoDB PITR export on a cron
-- (ATHENA_QUERY_CRON_TIME, default every 6 hours). Rows here reflect the last export,
-- not live state. Re-confirm every candidate with a point read immediately before
-- patching — some will already have been mitigated. Both DT-55836 claims were
-- repaired on 2026-10-07 and now read VERIFIED_APPROVED.
--
--   aws dynamodb get-item --table-name ClaimItem \
--     --key '{"id":{"S":"ClaimItem@<full-uuid>"}}' \
--     --projection-expression 'id,claimStatus,componentId,verificationRequestId'


-- =============================================================================
-- RECOVERING THE OLD TERMINAL STATUS  (the value to patch back)
-- =============================================================================
-- This query cannot tell you what to patch to. The snapshot database holds only
-- workflow, claimitem, verificationrequest and report — there is no `component`
-- table — so componentStatus is not reachable from Athena here.
--
-- Component.componentStatus is the source. ComponentService.determineTargetComponentStatus
-- derives componentStatus FROM claimStatus and throws INVALID_CLAIM_ITEM_STATUS_TO_VERIFY
-- for any non-terminal claimStatus, so the component holds the last persisted mirror of
-- the very claimStatus being restored — including any accreditation adjustment
-- updateClaimStatusFromAccreditation applied. The mapping back is the identity:
--     componentStatus VERIFIED_APPROVED  ->  claimStatus VERIFIED_APPROVED
--     componentStatus VERIFIED_REJECTED  ->  claimStatus VERIFIED_REJECTED
--     componentStatus UNABLE_TO_VERIFY   ->  claimStatus UNABLE_TO_VERIFY
--
-- If componentStatus is DRAFT or UNDER_REVIEW, verification never completed — the claim
-- is NOT an instance of this defect and must not be patched.
--
-- The mitigation scripts do exactly this, two point reads per claim, no scan:
--     dev-toolbox/vpt-dev-scripts/DT-56285-validated-claim-completed-workflow/
--       analyze.mjs    classify, read-only
--       mitigate.mjs   PATCH /claim-items/partial/:id { claimStatus }
--
-- AuditTrail was dropped as a cross-check: the /explore/AuditTrail/filter endpoint
-- returns 500 for unauthenticated callers, and the component is a strictly better
-- source anyway for the reason above.


-- =============================================================================
-- POSITIVE CONTROL
-- =============================================================================
-- Both DT-55836 claims (case S003-260814-7FF6A) were repaired on 2026-10-07 and will
-- NOT appear in this result set any more — their absence is the query correctly
-- dropping fixed claims, and the snapshot postdates the repair.
--
--   ClaimItem@d753d847-fb5e-49f7-948d-ec8561985fb0
--     ComponentType@nameChange, repaired to VERIFIED_APPROVED 2026-10-07T08:20:47Z
--
--   ClaimItem@24eb0bff-5cad-46a5-9dcd-08d01db3cef7
--     ComponentType@license, repaired to VERIFIED_APPROVED 2026-10-07T08:21:18Z
--     Its index-[0] verification response reads Positive /
--     SUCCESS-DIRECT-CONFIRMATION-IA, which agrees with the component. The earlier
--     "Unable to verify / Misrepresented Document" response was superseded.
--
-- To use them as a control, re-run against a snapshot predating 2026-10-07, or point
-- read them directly and confirm they now read VERIFIED_APPROVED.


-- =============================================================================
-- THE POPULATION WILL REGROW
-- =============================================================================
-- Repairing claimStatus does not remove the trigger. A dangling DRAFT validation
-- response on a post-verification claim will demote it again the moment it is closed.
-- Live proof: ValidationResponse@d289a3a1-a066-4b91-b585-887cc58ec037 is still DRAFT
-- and still attached to ClaimItem@24eb0bff-5cad-46a5-9dcd-08d01db3cef7, a claim that
-- has already been repaired. A terminal-status guard on validation-response closure is
-- a separate piece of work.


-- =============================================================================
-- ENTITY REFERENCE
-- =============================================================================
-- S003-260814-7FF6A                                   Source case whose claims were flipped
-- S003-260814-7FF6A-C32                               license claim workflow, COMPLETED/COMPLETED
-- S003-260814-7FF6A-7DE                               nameChange claim workflow, COMPLETED/COMPLETED
-- VerificationRequest@591b4bcf-b90d-428f-b951-eafcd3b41390   The case's VR
-- ClaimItem@24eb0bff-5cad-46a5-9dcd-08d01db3cef7      license claim, repaired 2026-10-07
-- Component@c7319b50-09b5-4dcc-b2e3-d60a659609d2      license component, componentStatus VERIFIED_APPROVED
-- ClaimItem@d753d847-fb5e-49f7-948d-ec8561985fb0      nameChange claim, repaired 2026-10-07
-- Component@3660e36a-0e0a-41c8-a4ed-68698bc0163e      nameChange component, componentStatus VERIFIED_APPROVED
-- ValidationResponse@adb8ad15-5850-47c7-8afb-0bf551355dce   Stale DRAFT closed 2026-09-10, flipped the license claim
-- ValidationResponse@c9689598-9ba9-4ef3-8f8d-105cb0eb64e8   Stale DRAFT closed 2026-09-10, flipped the nameChange claim
-- ValidationResponse@d289a3a1-a066-4b91-b585-887cc58ec037   Second stale DRAFT on the license claim, STILL DRAFT — future landmine
-- VerificationResponseV2@0e926591-66b1-4101-a1a2-5ae929f01bfb   license claim index-[0] response, Positive
-- VerificationResponseV2@1759ccac-6fa1-4f2a-b5c4-8d7f3f2a556d   license claim earlier response, superseded
-- BFFTraceId@7ba82094-8996-47e5-83e5-31702f1be06e      The request that did the damage (Validation screen, Process Request)
-- ClaimItem@b4afd72c-bc1d-4b4b-a36b-e7c775c221d1      legacy=true placeholder, excluded by the legacy guard
-- =============================================================================
