# MR Review Automation

Automated GitLab MR review using the `MR Reviewer` custom Kiro agent.

## How to use

Open Kiro, switch to the **MR Reviewer** agent (dropdown next to the chat input), then paste an MR link:

```
https://gitlab.com/dataflowgroup/dfg-product/core-platform/apollo-service/-/merge_requests/42
```

That's it. The agent handles everything else automatically.

---

## What happens (end to end)

1. **Parses** the MR URL to extract repo name, project path, and MR IID
2. **Fetches source branch** from GitLab via MCP
3. **Runs `mr-review-prep.sh`** — creates a git worktree at  
   `/Users/ravitejag/my-projects/mr-review-<repo>-<branch>` and runs `pnpm install`
4. **Pre-review hard gate** — checks MR description against VPT submission requirements; posts a rejection note and stops if any item is missing
5. **Fetches Jira context** — reads the ticket + parent story for acceptance criteria
6. **Fetches all diffs** from GitLab (paginated)
7. **Reads full local files** from the worktree — never just diff patches
8. **Five-dimension review**: Code Quality · Business Logic · Regression Risk · Test Coverage · Performance
9. **Presents the full review report** and asks whether to post
10. **Posts to GitLab** (inline comments and/or summary note) — only after explicit confirmation
11. **Runs `mr-review-cleanup.sh`** — removes the worktree, your active branch is never touched

---

## Scripts

### `mr-review-prep.sh <repo-name> <source-branch>`

- `git fetch`es the branch
- Creates a fresh worktree (removes stale one if it exists)
- Runs `pnpm install`
- Prints `WORKTREE_PATH=<path>` for the agent to consume

### `mr-review-cleanup.sh <repo-name> <source-branch>`

- `git worktree remove --force` + `git worktree prune`
- Safe to run even if the worktree was already deleted

---

## Agent location

`~/.kiro/agents/mr-reviewer.md` — user-level agent, available in all workspaces.
