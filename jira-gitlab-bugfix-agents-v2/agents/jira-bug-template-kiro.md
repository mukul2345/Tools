# Jira Bug Template for Agentic Fixes (Kiro-ready)

This template keeps your existing human-readable narrative — which reviewers rely on —
and adds **one machine-parseable block** (`KIRO-EXEC`) that Kiro extracts deterministically.

**Rule of thumb:** humans write the prose sections; the `KIRO-EXEC` block holds only the
few execution-critical facts an agent cannot safely infer from prose (branches, repo scope,
autonomy level). Derive what you can from native Jira fields (Components, custom fields) so
authors aren't hand-writing YAML for the whole ticket.

---

## 1. Native Jira fields (keep as-is, but enforce)

| Field | Requirement | Why it matters to Kiro |
|-------|-------------|------------------------|
| **Components** | Mandatory. Only valid values from the component→repo map. | Backbone of repo selection. Maps to `primary_repos`. |
| **Priority** | Mandatory. | Can gate autonomy (e.g. P1 → `propose` only). |
| **Labels** | Include `code_fix` when the ticket is agent-eligible. | Webhook/automation trigger filter. |
| **Fix versions** | Set for hotfixes. | Signals release cherry-pick policy. |
| **env** | `Prod` / `UAT` / etc. | Informs hotfix vs. normal flow. |
| **Assignee / Reviewer** | Set reviewer where possible. | Maps to MR `reviewer_ids`. |

---

## 2. Prose sections (the natural-language spec Kiro reads for *intent*)

Keep these exactly like your current DT-46133 ticket — they are already excellent:

- **Scenario** — what the user experiences and business impact.
- **Reference case** — a concrete reproduction pointer.
- **What Case Scenario Was Not Handled?** — root-cause narrative.
- **The Bug** — the offending file/function and a code snippet of the current behavior.
- **Proposed Solution** — the intended fix, ideally with a code sketch.
- **Acceptance Criteria** — testable outcomes, including the required regression test.

These give the agent *understanding*. The block below gives it *instructions*.

---

## 3. The `KIRO-EXEC` block (add this to every agent-eligible ticket)

Paste inside the description as a fenced `yaml` block. The `# --- KIRO-EXEC ---` /
`# --- END KIRO-EXEC ---` delimiters let Kiro locate and parse it unambiguously.

```yaml
# --- KIRO-EXEC ---
schema_version: 1

# How far the agent may go without a human.
#   propose   = open a draft plan/diff for review, do NOT push
#   auto-mr   = create branch, commit, open MR, assign reviewer (no merge)
#   auto-merge = only for pre-approved low-risk classes
autonomy: propose

# Repos where code actually changes. Values MUST come from the component→repo map.
primary_repos:
  - <repo-name>

# Read-only clones the agent may use for cross-repo context (types, shared libs, APIs).
context_repos: []

# true when the fix legitimately spans more than one primary_repo.
multi_repo: false

# Branching.
base_branch: develop        # fork point
target_branch: develop      # MR target (usually == base_branch)
hotfix: false               # if true, apply cherry-pick policy below
cherry_pick_to: []          # e.g. [release, develop] for hotfixes
branch_name: auto           # "auto" => Kiro derives <ISSUE-KEY>-<slug>; avoids typos

# Review + CI.
reviewers: []               # GitLab usernames -> MR reviewer_ids
tests_required: true
test_command: ""            # command Kiro must run green before opening the MR

# Where the fixer gets its spec (source of truth for the change).
#   analyzer   = use the analyzer's findings.md (default, two-agent flow)
#   jira       = use this ticket's Proposed Solution directly (analyzer bypass)
#   kiro_spec  = developer-authored Kiro spec on a branch (fixer-only, no analyzer)
spec_source: analyzer
spec_branch: ""             # required when spec_source: kiro_spec
spec_path: ""               # e.g. .kiro/specs/<feature>/  (requirements.md/design.md/tasks.md)

# Optional developer-verification artifacts (guide + OpenAPI + Postman). Default off.
manual_testing_artifacts: false

# Optional: fast-locate hints so the agent doesn't guess file paths.
entry_points:
  - repo: <repo-name>
    path: <relative/path/to/File.ts>
    symbol: <functionOrClassName>
# --- END KIRO-EXEC ---
```

### Field reference

| Key | Purpose | Notes |
|-----|---------|-------|
| `autonomy` | Controls how much the agent does unattended. | Start every class at `propose`; graduate proven classes to `auto-mr`. Never default to `auto-merge`. |
| `primary_repos` | Where edits land. | Validated against the component→repo map. Empty ⇒ agent stops and asks. |
| `context_repos` | Extra read-only context. | Cloned but never committed to. |
| `multi_repo` | Multi-repo planning flag. | `true` ⇒ agent plans across repos, **creates a Jira subtask per repo** (`[<repo>]` prefixed, inheriting parent fields), and each MR title uses its subtask key (not the parent bug key). |
| `base_branch` | Fork point. | **Most important missing field today** — never leave to inference. |
| `target_branch` | MR target. | Defaults equal to `base_branch`. |
| `hotfix` / `cherry_pick_to` | Release propagation. | Encodes the policy your DT-46133 ticket did by hand (release + develop). |
| `branch_name` | Branch to create. | Keep `auto` so Kiro derives it from the issue key deterministically. |
| `reviewers` | MR reviewers. | Maps to GitLab `reviewer_ids`. |
| `tests_required` / `test_command` | CI gate. | Agent must run this green before opening the MR. |
| `spec_source` | Where the fixer's spec comes from. | `analyzer` (default) / `jira` / `kiro_spec`. |
| `spec_branch` / `spec_path` | Kiro-spec location. | Required only when `spec_source: kiro_spec`. |
| `manual_testing_artifacts` | Emit verification guide + OpenAPI + Postman. | Default `false`; renders via script (no LLM tokens). |
| `entry_points` | Location hints. | Optional but hugely reduces wrong-file edits. |

---

## 4. Worked example — DT-46133 (from your sample ticket)

```yaml
# --- KIRO-EXEC ---
schema_version: 1
autonomy: auto-mr
primary_repos:
  - verification-workflow-engine
context_repos: []
multi_repo: false
base_branch: develop
target_branch: develop
hotfix: true
cherry_pick_to: [release, develop]
branch_name: auto            # -> DT-46133-preserve-remark-on-autoclose
reviewers:
  - anurag.mishra
tests_required: true
test_command: "npm test -- IAFollowUpHandler"
entry_points:
  - repo: verification-workflow-engine
    path: src/handlers/IAFollowUpHandler.ts
    symbol: closeFollowUp
# --- END KIRO-EXEC ---
```

This block, plus the existing prose sections, is everything Kiro needs to: read the bug,
clone `verification-workflow-engine`, locate `closeFollowUp`, apply the append-instead-of-
overwrite fix, run the targeted test, open an MR into `develop` with Anurag as reviewer, and
flag the hotfix cherry-picks.

---

## 5. Authoring checklist

- [ ] Components set from the approved map (not free text).
- [ ] `code_fix` label present.
- [ ] Prose sections filled: Scenario, Root cause, The Bug, Proposed Solution, Acceptance Criteria.
- [ ] `KIRO-EXEC` block present with `base_branch` and `target_branch` set.
- [ ] `autonomy` chosen deliberately (default `propose`).
- [ ] `test_command` provided when `tests_required: true`.
- [ ] Reviewer set.
