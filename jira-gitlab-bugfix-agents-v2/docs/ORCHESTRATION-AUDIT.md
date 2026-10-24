# Orchestration Audit — determinism vs. LLM reasoning

**Goal:** make the pipeline run more systematically (less reliance on the LLM for control
flow) and cut LLM credit usage, without weakening the reasoning that actually needs a model.

**Method:** walk every step of the current pipeline (orchestrator, analyzer, fixer) and tag it:

- 🟢 **Deterministic** — pure control flow, table lookup, shell, grep, or templating. Should be
  code. No model needed.
- 🟡 **Hybrid** — one genuine LLM decision wrapped in mechanical work. Split it: keep the
  decision in the model, push the mechanics into code.
- 🔴 **Needs LLM** — irreducible reasoning (comprehension, root-cause, writing the fix). Keep.

The one-line thesis: **the LLM should be called at exactly two nodes — *analyze* and
*implement* — and a deterministic driver should own everything else.** Today the models also do
a large amount of clerical work (control flow, map lookups, shell orchestration, grep-based
gates, templated output) token by token.

---

## 1. The orchestrator (Haiku) — removable in full

| Step | Tag | Why |
|------|-----|-----|
| 0 — Preconditions (file exists, `rm` stale brief) | 🟢 | Pure shell |
| 1 — Delegate to analyzer | 🟢 | Fixed dispatch |
| 2 — The gate (`test -f brief`) | 🟢 | A file-existence check |
| 3 — Delegate to fixer | 🟢 | Fixed dispatch |
| 4 — Report | 🟢 | Concatenate two summaries |

**Finding:** the orchestrator performs **zero reasoning**. Every line is deterministic control
flow, and `run-bugfix-pipeline.sh`'s own `--no-subagents` branch already implements the
identical logic in bash (`gather → run analyzer → if [[ ! -f brief ]] → run fixer`). The Haiku
session exists only to keep everything in one process so there is no manual `Ctrl+C` between
phases — a session-management convenience, not a reasoning need.

**Action:** delete the LLM orchestrator; let the deterministic driver sequence the two agents
and check the gate. This is the cleanest single cut and removes an entire model session per run.

---

## 2. The analyzer (Opus) — keep the core, script the edges

| Step | Tag | Notes |
|------|-----|-------|
| 1 — Parse ticket + KIRO-EXEC YAML | 🟡 | YAML extraction is regex + `yaml.safe_load` (code); "read the whole issue" is LLM |
| 2 — Absorb full history | 🔴 | Comprehension — keep |
| 3 — Resolve + clone repos | 🟡 | Map lookup + `git clone` are code; "which referenced repos are relevant" is light judgment |
| 4 — Factual analysis (grep refs, data flow, call graph, regression, flags) | 🔴 | grep *enumeration* is mechanical, but root-cause reasoning is the real Opus job — keep |
| 5 — Compare + gate | 🔴 / 🟢 | Alignment judgment is LLM; the gate *mechanism* (brief exists) is code |
| 6 — Cleanup (`rm -rf` clones) | 🟢 | Pure shell |

**Finding:** the analyzer holds a genuine 🔴 core — absorbing history (Step 2), reasoning to an
independent root cause (Step 4), and judging alignment (Step 5). Those stay in the model.
Everything around them (YAML parse, repo resolution, cloning, cleanup) is mechanical.

**Action:** move YAML parse, repo resolution, cloning, and cleanup into the driver. Have the
analyzer **emit a structured `findings.json`** (root cause, entry points, regression list,
feature flag, `package_change: bool`, `alignment: aligned|mismatch`) alongside its markdown, so
downstream steps branch on fields instead of re-reading prose.

---

## 3. The fixer (Sonnet) — where most hidden waste lives

| Step | Tag | Notes |
|------|-----|-------|
| 1 — Read ticket, resolve `spec_source` | 🟡 | `spec_source` switch + file load = code; understanding the spec = LLM |
| 2 — Resolve repositories | 🟢 | Table lookup + `type: code` filter — pure code |
| 2.6 — Detect shared-package change | 🟡 | Semantic call, but the **analyzer should emit this as a flag** so the fixer never re-derives it; package→{repo,path,branch} is a lookup |
| 3 — Clone / install / branch | 🟢 | Shell; `branch_name: auto` slug is deterministic |
| 3.5 — Shared-package changes | 🟡 | The type edit is LLM; version bump, CHANGELOG scaffold, `pnpm build`/`link` are scripted mechanics |
| 4 — Make the fix | 🔴 | The actual code change — the reason the system exists. Keep |
| 5 — Verify + coverage baseline/after | 🟡 | Running jest + recording before/after numbers = **script**; deciding whether to retry a failing test = LLM |
| **5.5 — Compliance gate** | 🟢 | lint/prettier zero-errors, `grep` for `jest.mock`/`jest.fn`/`: any`, logger assertions, private-member tests — a grep checklist, not reasoning |
| 6 — Autonomy gate | 🟢 | `switch(autonomy)` |
| 6.5 — Manual-testing artifacts | 🟡 | Mining real payloads for the manifest = LLM; rendering is *already* a 0-token script (the right pattern) |
| 6.7 — Multi-repo subtasks | 🟡 | Field inheritance is mechanical; only the summary text is LLM |
| 7 — Commit / push / MR | 🟡 | Commit format, target-branch rule, reviewer-ID resolution, dependency marker = templated/code; MR prose is LLM but sourced from the brief |
| 8 — Report back | 🟡 | Mostly a templated Jira comment |
| 9 — Cleanup (`rm -rf`) | 🟢 | Pure shell |

**Finding:** only Step 4 (and the retry judgment inside Step 5) is truly 🔴. A large fraction of
the fixer's tokens go to clerical work: map lookups, shell orchestration, a hand-run grep
compliance checklist, and assembling templated MR/Jira text.

---

## 4. The two highest-value cuts (beyond deleting the orchestrator)

These are worth doing first because they are **both wasteful and a reliability risk** — an LLM
doing them by hand can silently get them wrong.

1. **Step 5.5 — compliance gate → a script.** An LLM "grepping its test files and confirming
   zero matches of `jest.mock`" is exactly the failure mode where it reports zero and misses
   one. A ~30-line script that runs eslint + prettier + the greps and exits non-zero on any hit
   is cheaper *and* stricter than asking the model to self-audit.

2. **Step 5 — coverage baseline-vs-after → a script.** Running jest twice and diffing the
   per-file numbers is a deterministic computation, not a judgment. The model should only decide
   whether to retry a genuinely failing test.

---

## 5. The irreducible LLM surface

After the cuts above, what legitimately remains in the model:

- **Analyzer:** absorb history (Step 2), reason to an independent root cause (Step 4), judge
  alignment (Step 5).
- **Fixer:** write the actual code change (Step 4), and decide retry-on-test-failure (Step 5).

Everything else — control flow, map lookups, shell, grep gates, templated output — is clerical
work the model is currently doing token by token.

---

## 6. Target shape — invert the control plane

Today: an **LLM orchestrates** and the models do clerical work between reasoning.
Target: a **deterministic driver orchestrates** and calls the LLM at exactly two nodes.

Extend `jira_gather.py` into a Python **spine** that owns the sequence and calls the model only
to *analyze* and *implement*, each returning **structured JSON** plus its markdown:

```
gather (script)              ← already exists, 0 credits
  → extract KIRO-EXEC (script: regex + yaml)
  → resolve repos from map (script)
  → clone (script)
  → [LLM] analyze  → findings.json {root_cause, entry_points, regressions,
                                    feature_flag, package_change, alignment}
  → gate on findings.alignment (script)
  → [LLM] implement → implementation.json {files_changed, ...} + the diff
  → tests + coverage diff (script)
  → compliance gate (script → pass/fail)
  → autonomy branch (script)
  → render verification artifacts (script)   ← already exists, 0 credits
  → create subtasks / open MR (script templating; prose fields come from the LLM nodes)
```

**Enabling seam — structured hand-offs.** The agents already communicate via files
(`implementation-brief.md`, `analysis.md`) and the analyzer already writes a `ticket-history.json`
sidecar. Extend that pattern so each LLM node emits machine-readable JSON next to its markdown.
The driver then branches on fields instead of interpreting prose — which is what lets the gate,
package-detection, compliance, and MR steps all run in code.

**Bonus properties this buys:**

- **Checkpointing / resumability** — because each step's output is a file, a halted or failed run
  resumes at the last completed step instead of re-running (and re-paying for) everything
  upstream. Big saver on multi-repo tickets.
- **Independently testable steps** — each script step can be unit-tested; the grep gates become
  self-testing (matching the project's existing "deny patterns must be tested" discipline).

## 7. Hand-off file format — match the format to the data shape

Do **not** serialize the intermediate hand-offs as JSON. The reason is specific: these files
carry **fenced diffs and code snippets**, and putting code inside a JSON/YAML string forces
newline/quote escaping — exactly where LLMs produce broken syntax *and* waste tokens. Any format
must let code sit **raw behind a delimiter, never escaped into a string**.

The hand-offs are not one kind of data — they are three, each with a format that is both
LLM-cheap to emit and trivial for the driver to parse:

| Data shape | Examples | Best format | Why |
|------------|----------|-------------|-----|
| **Scalars / control fields** | `alignment`, `package_change`, `autonomy`, `base_branch` | flat `key: value` lines (tiny YAML/TOML block) | No braces/quotes; regex- or `safe_load`-parseable; cheapest possible |
| **Uniform lists** | entry points, regression call-sites, coverage before/after | **TSV** or **markdown table** | No repeated keys (JSON repeats every key per row); LLMs emit tables reliably |
| **Prose + code** | root-cause narrative, the actual diff | **markdown body + fenced ` ```diff ` blocks** | Zero escaping; human-readable for the review gates; what models emit best and cheapest |

Notes on the tempting alternatives: TSV beats CSV (no comma-quoting). TOML is cleaner than YAML
for scalars but not dramatically cheaper. **Binary/columnar formats (protobuf, msgpack, parquet)
are off the table** — they only pay off when both ends are machines, and here an LLM sits on one
side of every hand-off, so human/LLM readability dominates.

**Reuse the pattern already invented for the input.** The `KIRO-EXEC` block is a delimited,
machine-parseable region embedded in human prose. Do the same for the *outputs*: one file per
hand-off (not a `.md` + `.json` pair to keep in sync), human-readable for the gates, near-free to
emit. The driver parses only the delimited block + the tables it branches on; it ignores the
prose. The LLM just writes markdown — the cheapest, most reliable thing it does — and never
escapes a diff.

**Two caveats.** (1) If Kiro exposes structured-output / JSON mode, it guarantees valid JSON but
re-introduces the escape-the-diff problem and kills human-readability — if used at all, use it
only for the tiny control block, never for the brief body. (2) You also pay tokens to *describe*
the schema in the agent prompt; flat `key: value` and markdown tables need almost no explanation
(the model already knows them), whereas a verbose JSON Schema is a recurring per-run cost.

---

## 8. The hand-off contracts

Two files, each written by one LLM node, each read by the deterministic driver. Both follow the
same shape: a delimited `*-EXEC` scalar block (driver branches on this), markdown tables for
uniform lists, and prose + fenced ` ```diff ` for narrative/code.

### 8a. `findings.md` — written by the analyzer, read by the driver's gate

```markdown
# Findings — <ISSUE-KEY>

# --- FINDINGS-EXEC ---
schema_version: 1
alignment: aligned            # aligned | mismatch  -> the gate branches on this ONLY
package_change: false         # true => driver routes the fixer through the @dfg/* package flow
feature_flag: none            # flag key, or "none"
# --- END FINDINGS-EXEC ---

## Confirmed root cause
<1-2 paragraphs of prose, each claim citing file:line>

## Entry points (affected API routes)
| method | path | file:line |
|--------|------|-----------|
| POST | /verification-requests/{caseId}/follow-up | IAFollowUpHandler.ts:88 |

## Regression call-sites
| file:line | why it could be affected |
|-----------|--------------------------|
| FollowUpService.ts:142 | shares closeFollowUp entity |

## Files + symbols to change
| repo | path | symbol | intended change |
|------|------|--------|-----------------|
| verification-workflow-engine | src/handlers/IAFollowUpHandler.ts | closeFollowUp | append remark instead of overwrite |

## Test guidance
<which scenarios must be covered — prose>
```

Gate logic in the driver (no LLM): the brief is honored only when
`FINDINGS-EXEC.alignment == aligned`; on `mismatch` the driver posts the Jira comment (the prose
body) and halts. `package_change` and `feature_flag` are read straight from the block so the
fixer never re-derives them (removes fixer Step 2.6 re-analysis).

### 8b. `implementation.md` — written by the fixer, read by the driver's downstream steps

```markdown
# Implementation — <ISSUE-KEY>

# --- IMPL-EXEC ---
schema_version: 1
status: implemented           # implemented | stopped
stop_reason:                  # populated only when status: stopped
tests_passed: true
# --- END IMPL-EXEC ---

## Files changed
| repo | path | +lines | -lines |
|------|------|--------|--------|
| verification-workflow-engine | src/handlers/IAFollowUpHandler.ts | 4 | 1 |

## Coverage (before vs after, per changed file)
| repo | file | before % | after % | regression? |
|------|------|----------|---------|-------------|
| verification-workflow-engine | IAFollowUpHandler.ts | 71.2 | 78.9 | no |

## MR description blocks (prose the driver drops verbatim into the MR/Jira)
### Root-cause summary
<prose>
### Regression analysis
<prose>

## Diff
​```diff
- remarks = newRemark
+ remarks = [...remarks, newRemark]
​```
```

Downstream driver steps (no LLM): read `IMPL-EXEC.status` to decide whether to proceed to the
compliance-gate script (§4) and MR step; read the coverage table to enforce no-regression
mechanically; drop the "MR description blocks" prose verbatim into the templated MR body so the
model is never asked to assemble the MR envelope.

---

## 9. Trade-off to keep in mind

Determinism costs flexibility. A hardcoded spine handles the ticket shapes seen so far; a novel
shape (unusual cross-repo dependency, odd spec source) may still need a human or a small routing
decision at one branch point. The skill is drawing the line: **deterministic spine, LLM only at
the nodes that reason.** The existing `spec_source` seam is already a good example of an explicit
branch point rather than letting the model improvise.
