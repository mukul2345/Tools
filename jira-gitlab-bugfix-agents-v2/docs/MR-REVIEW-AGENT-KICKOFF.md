# Kickoff prompt — rebuild the MR-review agent (deterministic-spine architecture)

Copy everything in the fenced block below into a **new session** to start. Paste your existing MR
Review Kiro Power details where marked, and set the two paths. The prompt makes the session
**critique and propose first, then implement only after you approve** — it will not start writing
the agent until you say go.

---

```
You are helping me build an automated **Merge-Request review agent** on Kiro CLI. I have an
existing "MR Review Kiro Power" that works but was built ad hoc. I want to REBUILD it under a
specific architecture and set of non-functional requirements that I've already proven on a sibling
project (a Jira→GitLab bug-fixer). Follow this brief exactly.

## Reference material (READ-ONLY — do not copy wholesale)
1. My existing MR Review Kiro Power (the thing being rebuilt), pasted below. Treat it ONLY as a
   reference for WHAT the review must check — not HOW to structure it. Assume its orchestration and
   prompt design are what we are improving:
   <<< PASTE MR REVIEW KIRO POWER FILES / PROMPT / CONFIG HERE >>>

2. The sibling project to mirror for architecture and conventions:
   <<< PATH TO THE jira-gitlab-bugfix-agents REPO >>>
   In particular read `docs/ORCHESTRATION-AUDIT.md` (the design rationale), `scripts/run_pipeline.py`
   (the deterministic spine), `scripts/pipeline_lib.py` (parsers + the `*-EXEC` hand-off convention),
   and `scripts/compliance_gate.py` (a scripted, non-LLM standards gate). Reuse these patterns and,
   where sensible, the actual helpers — do not reinvent them.

## Non-negotiable principles (the NFRs)
1. **Invert the control plane.** A deterministic driver (Python/shell) owns the sequence and all
   control flow. The LLM is called ONLY at nodes that require genuine reasoning. Everything else —
   fetching the diff, parsing config, resolving policy, running linters/static analysis, gating,
   templating the review comment — is code, at 0 credits.
2. **Credit discipline.** No LLM for anything a lookup, regex, parser, linter, or static-analysis
   tool can do. Model-tier deliberately (cheap model for light judgment, stronger only where
   needed). Checkpoint each step to a file so a re-run resumes at the first missing output instead
   of re-paying for completed work.
3. **Single responsibility / guardrails.** The agent does EXACTLY ONE job: review. It must never
   fix, push, merge, approve, or modify code. When unsure, it STOPs and reports rather than
   guessing. Frame every required check as a HARD GATE — optional steps get silently skipped.
4. **Evidence over prose.** Every review finding must cite `file:line` grounded in the actual diff
   or a tool's output. No hallucinated issues, no comments on code outside the diff.
5. **Structured hand-offs, format-per-shape.** Between the driver and any LLM node, use ONE file
   per hand-off with: a delimited `*-EXEC` scalar block for control fields (flat key:value), markdown
   tables for uniform lists (findings, severities), and prose + fenced code for narrative/snippets.
   NEVER serialize code/diffs into JSON strings (escaping breaks and wastes tokens). Reuse the
   `# --- NAME-EXEC ---` / `# --- END NAME-EXEC ---` convention from the sibling repo.
6. **Multi-agent only if justified.** Default to a single review agent. Propose splitting into
   multiple agents ONLY if there is a real reason (e.g. a distinct model need, or a
   separation-of-duties guardrail). If you do split, each agent still does exactly one job and hands
   off via files + a gate.
7. **Determinism gotchas to respect** (learned the hard way): shell deny-regexes must be precise and
   self-tested against real branch names / paths; each shell call is independent (no `cd`
   carryover — use absolute paths or `&&`); clone/work under a deterministic temp dir and clean up
   on success; never touch protected branches.

## Phase 1 — Critique & propose (DO THIS FIRST; then STOP for my approval)
Do NOT write the agent yet. First produce:
1. **Critique of the existing Power** — concretely, what it does that an LLM shouldn't (control flow,
   lookups, checks a linter/static-analyzer could do), where it risks doing more than one job, where
   findings aren't grounded in evidence, and where credits are wasted.
2. **Industry standards for automated MR review** — what good looks like (deterministic linters /
   type-checks / static analysis first; review the DIFF not the whole repo; severity-tiered,
   file:line-grounded output; no auto-approve; no nit-flooding; respect existing CI; idempotence).
   Say which the current Power is missing.
3. **A step-by-step audit** of the intended review pipeline, tagging every step 🟢 deterministic /
   🟡 hybrid / 🔴 needs-LLM, exactly like `ORCHESTRATION-AUDIT.md`. Make explicit how small the 🔴
   LLM surface can be (ideally: only the semantic-review judgment on the changed code).
4. **A proposed architecture** — the deterministic spine's step sequence, the single-vs-multi-agent
   decision with justification, the `*-EXEC` hand-off contract(s), and the guardrails that keep the
   agent to one job.
Then WAIT for my approval before implementing.

## Phase 2 — Implement (only after I approve the plan)
- Build the deterministic spine + the scripted gates first; add the LLM review node last.
- Keep deterministic parsers/logic in importable, unit-testable functions.
- VERIFY as you go: test parsers/gates against real inputs (a real diff, the real config), not
  assumptions. Include a verification step in your task list.
- Match the sibling repo's file conventions and portability approach (placeholder-substituted paths,
  secrets from the keychain/env, scripts stdlib-first).

## Hard "do NOT" list
- Do not let the LLM orchestrate, resolve config, or run checks a tool can run.
- Do not have the agent fix, push, merge, approve, or edit code — review only.
- Do not emit findings not grounded in the diff / a tool's output.
- Do not start Phase 2 before I approve Phase 1.
```

---

**How to use:** paste your Power files at the first placeholder, set the sibling-repo path at the
second, and send. The new session will come back with a critique + audit + proposed architecture for
you to approve before it writes anything. Once you've pasted the Power details here, I can also
pre-tailor this prompt (e.g. bake in the specific checks your Power performs) so the new session
starts even more grounded.
