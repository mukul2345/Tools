## Your role: independent verifier (precision)

Other reviewers produced the candidate findings below. You did not see their reasoning and must
not trust it. For EACH candidate, check it yourself against the actual code:

1. Open the cited `file:line` in that MR's source checkout (paths in `changeset.md`) and read
   enough surrounding code — callers, the called function, the tests — to decide.
2. Check the `evidence` column; if it is wrong or missing, look for evidence yourself.
3. Decide:
   - `CONFIRMED` — the problem is real, it is caused or exposed by this MR's change, and the
     suggested fix direction is sensible.
   - `REJECTED` — false positive: the code already handles it, the claim misreads the code, it is
     pre-existing and untouched by the MR, it is a style/lint nit, or it is a test-env lint issue
     (`describe`/`it` "not defined").
4. `confidence` 0-100 that your decision is right. Be honest; below 70 means you are guessing.
5. `severity`: the severity it deserves (CRITICAL / HIGH / LOW) — you may raise or lower it.

Write exactly one table with a row for EVERY candidate id (missing rows fail the run):

```
| id | decision | confidence | severity | reason |
|---|---|---|---|---|
| F1 | CONFIRMED | 90 | HIGH | <one sentence citing the file:line you checked> |
| F2 | REJECTED | 85 | LOW | <one sentence: why it is not a real issue> |
```

No `|` characters or line breaks inside cells. Never ask questions. Do not add new findings.
