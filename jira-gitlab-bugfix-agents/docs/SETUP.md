# Jira Bug Fixer — Setup & First Run (detailed reference)

> **Quick install:** from the repo root just run **`./deploy.sh`** — it copies everything into
> place (with portable paths) and validates the agents. This document is the detailed manual
> reference and troubleshooting guide; the `cp` commands below assume flat files and predate the
> `agents/ steering/ config/ scripts/ bin/` repo layout, so prefer `deploy.sh` for installation.

Base folder assumed: `~/my-projects/`
Goal of this guide: get to a **safe `propose`-mode dry run** on one ticket (no MR, just a
posted diff), then graduate to `auto-mr`.

> **Two-agent pipeline additions** are in the appendix at the bottom (analyzer agent, the two
> Python scripts, extra secrets, and `run-bugfix-pipeline.sh`). Do the single-agent setup first,
> then the appendix.

---

## Phase 0 — Prerequisites (5 min)

```bash
# Kiro CLI present and recent (headless needs 2.0+)
kiro-cli version
kiro-cli update            # if older

# You are logged in
kiro-cli whoami            # else: kiro-cli login

# Tooling the agent shells out to
git --version
node --version && npm --version
```

If any are missing, install them before continuing.

---

## Phase 1 — Rotate & store secrets (do NOT skip)

1. **Revoke the leaked GitLab PAT** (the `glpat-…` that was in the old config):
   GitLab → User Settings → Access Tokens → revoke it.
2. **Create a new GitLab PAT** with scopes: `api`, `read_repository`, `write_repository`.
3. **Create a Kiro API key** (headless auth): https://app.kiro.dev → API keys.
4. **Store both in the macOS keychain** (never in files):

```bash
security add-generic-password -s gitlab-pat   -a "$USER" -w   # paste the new PAT when prompted
security add-generic-password -s kiro-api-key -a "$USER" -w   # paste the Kiro API key
```

The runner reads them from the keychain at run time (see Phase 4).

---

## Phase 2 — Place the files

```bash
# Control folder for this agent
mkdir -p ~/my-projects/jira-bug-fixer
cd ~/my-projects/jira-bug-fixer
# → copy run-bug-fixer.sh here, then:
chmod +x run-bug-fixer.sh

# Global agent + its reference files (found from any directory)
mkdir -p ~/.kiro/agents
cp jira-bug-fixer.json            ~/.kiro/agents/
cp jira-bug-fixer-prompt.md       ~/.kiro/agents/
cp jira-bug-template-kiro.md      ~/.kiro/agents/
cp component-repo-mapping-kiro.md ~/.kiro/agents/
cp coding-guideline.md            ~/.kiro/agents/
cp merge-request-process-vpt.md   ~/.kiro/agents/

# Global MCP config
mkdir -p ~/.kiro/settings
cp kiro-mcp.fixed.json ~/.kiro/settings/mcp.json
```

The agent's `resources` use `file://./…` which resolve **next to the agent JSON**, so all four
files must sit together in `~/.kiro/agents/`.

---

## Phase 3 — Fill in your real values

Edit `~/.kiro/agents/component-repo-mapping-kiro.md`:

- Replace the placeholder GitLab group paths (`dataflowgroup/DFG-Product/…`) with your real ones.
- Set `default_reviewers` to real GitLab usernames.
- Add an entry for every Jira Component that can appear on a ticket.

Sanity-check the `workflow-mcp-server` path in `mcp.json` still points at your built
`dist/index.js`.

---

## Phase 4 — Verify connections before any run

```bash
# Load secrets into this shell
export GITLAB_PERSONAL_ACCESS_TOKEN="$(security find-generic-password -s gitlab-pat -w)"
export KIRO_API_KEY="$(security find-generic-password -s kiro-api-key -w)"

# Validate the agent config parses
kiro-cli agent validate ~/.kiro/agents/jira-bug-fixer.json
kiro-cli agent list                      # jira-bug-fixer should appear

# Confirm MCP servers start
kiro-cli mcp list
kiro-cli mcp status --name Gitlab
kiro-cli mcp status --name atlassian-rovo   # will prompt OAuth in browser on first use
```

**Confirm the real tool names** (they vary by MCP server version). Start an interactive session
and ask it to list tools:

```bash
kiro-cli chat --agent jira-bug-fixer
# then type:  /tools
```

Check that these exist, and if the names differ, update `mcp.json` autoApprove **and**
`jira-bug-fixer.json` allowedTools to match:

- Jira write-back: `addCommentToJiraIssue`  (Rovo)
- GitLab MR: `create_merge_request`         (zereight server)

---

## Phase 5 — Prepare ONE test ticket (propose mode)

Pick a small, real bug (or reuse DT-46133). Add the `KIRO-EXEC` block to its description with
`autonomy: propose`. Minimum viable block:

```yaml
# --- KIRO-EXEC ---
schema_version: 1
autonomy: propose
primary_repos: [verification-workflow-engine]
base_branch: develop
target_branch: develop
branch_name: auto
tests_required: true
test_command: "npm test -- IAFollowUpHandler"
entry_points:
  - repo: verification-workflow-engine
    path: src/handlers/IAFollowUpHandler.ts
    symbol: closeFollowUp
# --- END KIRO-EXEC ---
```

Make sure every component on that ticket exists in your mapping file.

---

## Phase 6 — First dry run

```bash
cd ~/my-projects/jira-bug-fixer
./run-bug-fixer.sh DT-XXXXX          # your test issue key
```

Because `autonomy: propose`, the agent will: read the ticket, resolve the repo, clone it, make
the fix on a scratch branch, run the tests, and **post the proposed diff as a Jira comment** —
it will NOT push or open an MR.

**Verify success:**

- A comment appears on the Jira ticket with a root-cause summary + patch + test result.
- No new branch/MR in GitLab.
- Check the run log:  `cat /tmp/jira-bug-fixer.log`

---

## Phase 7 — Graduate to auto-mr

Once a few propose runs look right, flip that ticket's block to `autonomy: auto-mr` and re-run.
The agent will additionally push the branch, open an MR (reviewer assigned), and comment the MR
URL back on the ticket. It will **never merge** — that stays with your reviewer/CI.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `MCP server failed to start` | `kiro-cli mcp status --name <server>`; check `mcp.json` path/env. Run had `--require-mcp-startup` so it fails fast by design. |
| Agent halts with "not agent-ready" | The ticket has no parseable `KIRO-EXEC` block. |
| Agent halts on repo resolution | The component isn't in `component-repo-mapping-kiro.md`, or it's marked `type: area`. |
| Tool call rejected / prompts | Tool name mismatch — reconcile `mcp.json` autoApprove and agent `allowedTools` with `/tools` output. |
| Auth error on push | PAT missing `write_repository`, or the keychain export didn't run in this shell. |
| Verbose logs | `export KIRO_LOG_LEVEL=debug` before the run. |

---

# Appendix — Two-agent pipeline (analyzer → fixer)

Adds an Opus analyzer that independently verifies the bug before the Sonnet fixer implements it.

### A1 — Extra secrets (Jira API token for the gather-script)

The gather-script calls the Jira REST API directly (not via MCP), using a Jira API token.

```bash
# Create a token at id.atlassian.com -> Security -> API tokens, then:
security add-generic-password -s atlassian-email     -a "$USER" -w   # your Atlassian email
security add-generic-password -s atlassian-api-token  -a "$USER" -w   # the API token
security add-generic-password -s jira-base-url        -a "$USER" -w   # https://<site>.atlassian.net
```

### A2 — Place the scripts and the analyzer agent

```bash
mkdir -p ~/my-projects/jira-bug-fixer/scripts
cp jira_gather.py build_verification_artifacts.py ~/my-projects/jira-bug-fixer/scripts/
cp run-bugfix-pipeline.sh ~/my-projects/jira-bug-fixer/ && chmod +x ~/my-projects/jira-bug-fixer/run-bugfix-pipeline.sh

cp jira-bug-analyzer.json        ~/.kiro/agents/
cp jira-bug-analyzer-prompt.md   ~/.kiro/agents/
# orchestrator (single-session subagent pipeline):
cp jira-bugfix-orchestrator.json jira-bugfix-orchestrator-prompt.md ~/.kiro/agents/
# refresh the fixer + template (spec_source seam, manifest step, model):
cp jira-bug-fixer.json jira-bug-fixer-prompt.md jira-bug-template-kiro.md ~/.kiro/agents/

kiro-cli version   # need >= 1.23 for subagent support
kiro-cli agent validate --path ~/.kiro/agents/jira-bug-analyzer.json
kiro-cli agent validate --path ~/.kiro/agents/jira-bug-fixer.json
kiro-cli agent validate --path ~/.kiro/agents/jira-bugfix-orchestrator.json
```

The scripts are **stdlib-only Python** — no `pip`/venv needed on Apple silicon. (If you ever add a
dependency, create a local `python3 -m venv ~/my-projects/jira-bug-fixer/.venv` and install there.)

### A3 — Run the pipeline

```bash
cd ~/my-projects/jira-bug-fixer
./run-bugfix-pipeline.sh DT-XXXXX --prefixes DT,VP
```

- **Phase 0** gathers ticket history → `/tmp/kiro-bugfix/DT-XXXXX/ticket-history.md`.
- **Phase 1** runs the analyzer; it writes `implementation-brief.md` if its independent analysis
  agrees with the ticket, or posts a Jira comment and **halts** on mismatch.
- **Gate**: the fixer runs only if the brief exists.
- **Phase 2** runs the fixer against the approved brief.

By default the runner launches **one orchestrator session** that delegates to the analyzer and
fixer as **subagents** — so there is **no manual Ctrl+C between phases**. Watch the subagents live
with **Ctrl+G**; when the run finishes, exit the single session once. (Requires Kiro CLI 1.23+.)

- `--no-subagents` falls back to the legacy two-session mode (you must exit the analyzer session to
  continue).
- With `KIRO_API_KEY` set, either mode runs fully headless/unattended.

### A4 — Optional per-ticket KIRO-EXEC switches

- `spec_source: jira` → skip the analyzer, fixer uses the ticket's Proposed Solution.
- `spec_source: kiro_spec` + `spec_branch` + `spec_path` → fixer implements a developer-authored
  Kiro spec on a branch (run the fixer alone, not the pipeline).
- `manual_testing_artifacts: true` → fixer emits the manifest and renders
  `verification/verification-guide.md` + OpenAPI + Postman into the branch.
```
