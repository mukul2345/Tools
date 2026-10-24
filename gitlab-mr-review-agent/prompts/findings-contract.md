## Output contract (the spine parses this — follow it exactly)

Write a `## Findings` section containing ONE pipe table with exactly these columns:

```
## Findings
| mr | file:line | dimension | severity | issue | suggested_fix | evidence |
|---|---|---|---|---|---|---|
| verification-request!5535 | `src/modules/vr/VRService.ts:142` | regression | HIGH | <one sentence> | <one sentence> | <file:line you read that proves it> |
```

- `mr`: one of {MR_KEYS} — the MR whose changed line the finding sits on.
- `file:line`: repo-relative path + a line number that is a CHANGED (added) line in that MR's
  diff, or within 2 lines of one. Findings off the diff are dropped automatically.
- `dimension`: business_logic | regression | test_coverage | code_quality | performance
- `severity`: CRITICAL (merge blocker: broken AC, data loss, security, contract break) | HIGH
  (real regression risk, missing key test, measurable perf hit) | LOW (worth knowing, optional).
  When unsure, choose the lower one.
- `issue` / `suggested_fix`: one sentence each, no `|` characters, no line breaks.
- `evidence`: the concrete code you read that proves the issue (`file:line`, or
  `repo:file:line` for another MR). A finding without evidence will be rejected by the verifier.

If you find nothing, still write the table header and no rows. Never ask questions.
