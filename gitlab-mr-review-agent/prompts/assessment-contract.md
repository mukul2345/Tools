## Per-MR assessment (also required from you)

After the findings table, write one section per MR under review ({MR_KEYS}), exactly:

```
## <mr key>
### Business-logic alignment
| goal / acceptance criterion | status | file:line / note |
|---|---|---|
| AC-1 ... | ✅ / ❌ / ⚠️ | ... |

### Regression risks
<2-6 bullets: entry point -> what could break -> how to verify. "None identified." if none.>
```

Keep it short; it becomes the MR's summary note. Describe what the code does against each goal —
do NOT cite your own findings or their severities here ("— HIGH finding"): findings are verified
separately and some will be rejected, so the assessment must stand on its own.
