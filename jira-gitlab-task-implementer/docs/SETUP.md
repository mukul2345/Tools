# Task Implementer — Setup & First Run

Base folder assumed: `~/my-projects/`. Goal: get to a safe first run — implement one small task,
push a branch (no MR), and comment on the subtask — then graduate to `create_mr: true`.

This tool shares its secrets and MCP servers with the `jira-gitlab-bugfix-agents`. If you've already
set that up, you only need `deploy.sh` here.

---

## Phase 0 — Prerequisites

```bash
kiro-cli version          # 2.14+ recommended
kiro-cli whoami           # else: kiro-cli login
git --version
node --version && corepack enable && pnpm --version   # target repos use pnpm
python3 --version         # system Python 3 is fine (scripts are stdlib-only)
```

---

## Phase 1 — Secrets (macOS keychain, never inline)

Same items as the bug-fixer — skip any you already have:

```bash
security add-generic-password -s gitlab-pat          -a "$USER" -w   # GitLab PAT: api, read_repository, write_repository
security add-generic-password -s atlassian-email     -a "$USER" -w   # your Atlassian email
security add-generic-password -s atlassian-api-token -a "$USER" -w   # token from id.atlassian.com -> Security -> API tokens
security add-generic-password -s jira-base-url       -a "$USER" -w   # https://<site>.atlassian.net
```

The launcher exports these at run time. `KIRO_API_KEY` is optional — set it to run the implement
agent headless; otherwise it runs interactively against your `kiro-cli login` session.

---

## Phase 2 — Install

```bash
cd <this-repo>
./deploy.sh
```

`deploy.sh` copies the agent (with your real `~/.kiro` path substituted for `__KIRO_HOME__`),
steering, scripts, the example config, and the runner into `~/.kiro` and
`~/my-projects/jira-task-implementer`, then validates the agent. It installs `mcp.json` from the
example only if you don't already have one.

Verify:

```bash
kiro-cli agent validate --path ~/.kiro/agents/task-implementer.json
kiro-cli agent list                     # task-implementer should appear
kiro-cli mcp status --name Gitlab
kiro-cli mcp status --name atlassian-rovo
```

Confirm the real tool names in an interactive session (`/tools`) and, if they differ, reconcile
`~/.kiro/settings/mcp.json` autoApprove **and** `task-implementer.json` allowedTools:

- Jira write-back: `addCommentToJiraIssue`  (Rovo)
- GitLab MR: `create_merge_request`         (zereight server)

---

## Phase 3 — Sanity-check the deterministic layer (no credits)

Before a real run, exercise the spine's scripts directly — they cost nothing:

```bash
cd ~/my-projects/jira-task-implementer/scripts

# 1) The lib self-test (parser + selection + model mapper)
python3 task_pipeline_lib.py

# 2) Your Jira token resolves the subtask (prints summary/type/status)
export ATLASSIAN_EMAIL="$(security find-generic-password -s atlassian-email -w)"
export ATLASSIAN_API_TOKEN="$(security find-generic-password -s atlassian-api-token -w)"
export JIRA_BASE_URL="$(security find-generic-password -s jira-base-url -w)"
python3 jira_client.py DT-XXXXX
```

---

## Phase 4 — First run (branch-only, one task)

```bash
cd ~/my-projects/jira-task-implementer
cp config/run.example.yml config/run.yml
```

Edit `config/run.yml`:

```yaml
jira_id: "DT-XXXXX"
repo_url: "https://gitlab.com/<group>/<repo>"
source_branch: "develop"
spec:
  location: "repo"
  path: ".kiro/specs/<your-spec>"     # must contain tasks.md on source_branch
tasks:
  list: ["15.4"]                       # one small, self-contained task to start
unit_tests: true
create_mr: false                        # branch-only for the first run
model: "opus"
```

Run it:

```bash
./run-task-implementer.sh --config config/run.yml
```

What happens: the spine validates everything (STOPs early with a clear message if an input is
missing), clones the repo, selects task 15.4, forks the work branch, and the implement agent writes
the code, runs the gate scripts, commits + checks off the task, and **pushes the branch** (no MR
because `create_mr: false`), then comments on the subtask.

**Verify success:**
- A new branch on GitLab with your commit(s); no MR.
- A comment on the Jira subtask.
- `cat /tmp/kiro-task/DT-XXXXX/*/implementation.md` shows `status: implemented`.
- `cat /tmp/task-implementer.log` for the shell trace.

---

## Phase 5 — Graduate to MR mode

Flip `create_mr: true` and re-run (use a fresh `--branch` if you want a new branch). The agent will
additionally open a VPT-compliant MR (Jira id in the title, coverage before/after, regression
summary, acceptance-criteria checklist) and set reviewers. It **never merges** — that stays with
your reviewer + CI.

For multiple MRs on one subtask, run again with a different `--branch` and task selection.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `MCP server failed to start` | `kiro-cli mcp status --name <server>`; fix `mcp.json` local paths. |
| STOP: `source_branch not found` / `tasks.md not found` | Fix `source_branch` / `spec.path` / `spec.branch` in the config. |
| STOP: `selection matched no runnable tasks` | Tasks are `[x]` done, or optional with `tasks.optional: false`. |
| STOP: `task id … parsed as a number` | Quote task ids: `"15.10"`. |
| STOP: Jira preflight failed | Check the four keychain items; confirm VPN/proxy on timeout. |
| Gate fails on the spine's re-check | The branch is already pushed; inspect the gate output and fix, then re-run `--from implement --force`. |
| Verbose logs | `export KIRO_LOG_LEVEL=debug` before the run. |
