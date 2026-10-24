# DT-56285 — claims stuck at VALIDATED with a COMPLETED workflow

Restores the terminal `claimStatus` that was lost when a stale DRAFT validation response
was closed on a claim whose workflow had already moved past VERIFICATION.

## The defect, in one paragraph

Closing a validation response demotes its claim to `VALIDATED`. That is correct while the
claim is mid-flight. It is wrong once the claim's `CLAIM_VERIFICATION_WORKFLOW` has reached
`COMPLETED`, because nothing downstream will ever re-promote it — the workflow is not coming
back round to VERIFICATION. The claim is left at `VALIDATED` forever, holding a status it
earned and then lost. Report transfer then rejects the whole case, because the status gate in
`getTransferableComponentFromVR` requires every claim to be in an allowed terminal status.

## What the mitigation does

Exactly one write per claim:

```
PATCH /verification-request/claim-items/partial/{claimItemId}
{ "claimStatus": "<recovered terminal status>" }
```

Nothing else. No VR status roll-up, no workflow enqueue, no frontload, no changes to
validation responses. Anything downstream that needs recomputing is a separate step with its
own approval.

## Where the recovered value comes from

The **audit trail is the source**; the **component is an independent cross-check**.

For each claim, `analyze.mjs` finds the *last* AuditTrail record whose `modifiedAttributes`
contains `claimStatus` with `newValue = VALIDATED`, and reads that entry's `oldValue`. That is
literally the status the claim held immediately before the demotion.

It is the *last* such transition and not the first on purpose: if a claim bounced in and out of
`VALIDATED`, only the transition that produced the current state reflects what was actually
lost. Restoring from the first flip would resurrect a value that was later legitimately
superseded.

Separately it reads the live `Component.componentStatus`. A claim is only eligible when the two
agree. `ComponentStatus` and the three terminal `ClaimStatus` values are the same strings
(`VERIFIED_APPROVED`, `VERIFIED_REJECTED`, `UNABLE_TO_VERIFY`), so the comparison is direct.

| Audit `oldValue` | `componentStatus` | Bucket |
| --- | --- | --- |
| terminal | same terminal | `ready-to-mitigate` |
| terminal | different terminal | `needs-manual-review` |
| terminal | non-terminal / absent | `needs-manual-review` |
| non-terminal / absent | anything | `needs-manual-review` |
| no flip record found | anything | `no-audit-evidence` |

Disagreement is always a skip, never a guess. Neither source is trusted alone: the audit trail
can be missing for old claims, and the component is a parallel record that accreditation
handling can legitimately move away from the claim's own history.

## Exclusions applied before anything else

**`legacy = true`.** The Report Transfer with Past Case flow in garuda
(`validator.controller.ts`, `reportTransferWithPastCase.helper.ts`) creates placeholder claims
with `claimStatus: ClaimStatus.VALIDATED` hardcoded, and a synthetic workflow that
`WorkflowController` stamps `COMPLETED` at creation. These match the detection query by
construction and have no terminal status to restore. Patching them would invent data.

**Already repaired.** The Athena snapshot is up to six hours stale and claims do self-repair.
Every claim is re-read live, in `analyze.mjs` and again in `mitigate.mjs` immediately before
its write.

## Usage

```bash
pnpm install

# 1. Drop the Athena CSV in this directory
#    claim_items_with_progress_evidence.csv

# 2. Read-only classification. Writes nothing.
node analyze.mjs

# 3. Inspect ready-to-mitigate.json and needs-manual-review.json by hand.

# 4. Dry run — prints the exact payloads, still writes nothing.
node mitigate.mjs

# 5. First real batch. Verify these five before going further.
node mitigate.mjs --execute --limit 5

# 6. The rest.
node mitigate.mjs --execute
```

`BASE_URL` at the top of both scripts defaults to **prod**. The staging URL is in a comment
directly above it.

Re-running `mitigate.mjs` is safe. Claims already at their target are skipped as
`ALREADY_AT_TARGET`, so a partial or failed run can just be resumed.

## Output files

| File | Meaning |
| --- | --- |
| `ready-to-mitigate.json` | audit and component agree — the only input `mitigate.mjs` will act on |
| `needs-manual-review.json` | disagreement or non-terminal `oldValue` — needs a human |
| `no-audit-evidence.json` | no flip record found, likely audit retention |
| `already-repaired.json` | no longer `VALIDATED` live |
| `excluded-legacy.json` | `legacy = true` placeholders |
| `fetch-errors.json` | transient failures, re-runnable |
| `mitigate-results-<ts>_DRYRUN.json` | planned updates |
| `mitigate-results-<ts>_LIVE.json` | applied updates, with before and after status |

## Known gap: the population will regrow

Repairing `claimStatus` does not remove the trigger. A dangling DRAFT validation response on a
completed claim will demote it again the moment someone closes it.

Live proof: `ValidationResponse@d289a3a1-a066-4b91-b585-887cc58ec037` is still `DRAFT` and
still attached to `ClaimItem@24eb0bff-5cad-46a5-9dcd-08d01db3cef7`, a claim that has already
been repaired to `VERIFIED_APPROVED`.

Closing those responses, and adding a terminal-status guard so closure cannot demote a claim
whose workflow is already COMPLETED, are separate pieces of work.

## Entity reference

- `ClaimItem@24eb0bff-5cad-46a5-9dcd-08d01db3cef7` — DT-55836 license claim, repaired to `VERIFIED_APPROVED` 2026-10-07T08:21:18Z, still carries a DRAFT validation response
- `ClaimItem@d753d847-fb5e-49f7-948d-ec8561985fb0` — DT-55836 nameChange claim, repaired to `VERIFIED_APPROVED` 2026-10-07T08:20:47Z
- `ValidationResponse@d289a3a1-a066-4b91-b585-887cc58ec037` — still DRAFT, created 2026-08-14T12:08:07Z, the live regrowth vector
- `ClaimItem@b4afd72c-bc1d-4b4b-a36b-e7c775c221d1` — the `legacy = true` placeholder that motivated the legacy exclusion
- `Component@5d828655-96e3-4652-8080-ee6124adc35c` — its component, `componentStatus: DRAFT` under a `VALIDATED` claim
- `M006-2204-1067646-HL01` — its synthetic workflow, version 1, COMPLETED at creation
- `VerificationRequest@01ea9b7b-cbb4-4510-bca5-8f1688fb9445` — the migrated 2022 legacy VR it hangs off
- `ClaimItem@01ceae8a-c37e-4631-95eb-0d30aee3bac2` — verified sample, workflow `S003-260830-39D18-B90`
- `ClaimItem@e6377131-3725-476d-ac8a-2393675193cc` — verified sample, workflow `O002-260907-970FF-C48`

## Related

- Detection query: `DT-56285-validated-claim-completed-workflow.sql` (repo root)
- Per-CTE debugging: `DT-56285-cte-debug.sql` (repo root)
