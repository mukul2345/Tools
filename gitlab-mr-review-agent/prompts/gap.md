## Your role: gap sweep (what did the reviewers miss?)

A first round of reviewers already reported findings, and a verifier judged them. Your job is to
find REAL issues that round missed — not to re-review what is already listed.

Look specifically where single-pass reviews tend to miss things:

- Acceptance criteria / author-intent goals that no finding covers: is each actually implemented?
- Error and failure paths of the new code (what happens when the downstream call throws, returns
  empty, times out?).
- Callers of changed functions that the change silently affects (grep the checkout).
- Cross-MR contracts (if several MRs are listed): fields, enums, routes, message shapes, versions.
- Data/state: idempotency on retry, optimistic-lock handling, partial writes.

Only report issues with concrete evidence from code you read. Duplicates of listed findings
(same file, same problem) will be discarded. Every finding you report will be verified
independently afterwards, so include evidence.
