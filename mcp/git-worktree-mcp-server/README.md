# Git Worktree MCP Server

An MCP server that discovers every git repo under a root folder, pulls `master`
into a **separated central worktree** (leaving your working branch untouched),
and manages per-branch worktrees (develop / release / custom).

Handles the nested layout where a parent folder (e.g. `VTP/`) is **not** itself a
repo but its children are — the scanner finds the real repos and treats each as a
leaf (it won't descend into a repo's own subfolders or into `node_modules`,
`dist`, `build`, etc.).

## Tools

| Tool | Description |
|------|-------------|
| `discover_repos` | Read-only scan. Lists every repo with current branch, default branch, dirty state, and existing worktrees. Use this as your "scope review". |
| `sync_master` | For all repos (or one): ensure a central `master` worktree exists, then `checkout master` + `git pull --ff-only` **inside that worktree**. Skips dirty repos by default. Supports `dryRun`. |
| `create_worktree` | Add a worktree for any branch (`develop`, `release`, custom) at the central location, for one repo or all. Optional pull. |
| `list_worktrees` | List existing worktrees for one repo or all. |
| `remove_worktree` | Remove a worktree. Refuses if it has uncommitted changes unless `force: true`. |

## Setup

```bash
cd VTP/git-worktree-mcp-server
npm install
npm run build
```

Already registered in `~/.kiro/settings/mcp.json` as `git-worktree-mcp-server`
with:

- `WORKTREE_SCAN_ROOT=/Users/karansinha/dataflow-dev` — default folder to scan
- `WORKTREE_ROOT=/Users/karansinha/dataflow-dev/.worktrees` — central worktree location (outside every repo, so it never pollutes a working tree)

Reconnect the server from the Kiro MCP panel after building.

## How the master separation works

- The master worktree lives at `<WORKTREE_ROOT>/<repo-name>-master`, e.g.
  `.worktrees/ia-service-master`.
- `sync_master` **never switches your main checkout's branch.** It only touches
  the isolated master worktree. Your main dir stays on develop/release/whatever.
- The pull is always `--ff-only`, so a diverged master is reported as a failure
  rather than silently merged/rebased.
- `master` is preferred over `main`; `origin/HEAD` is ignored for this decision
  (some repos here point `origin/HEAD` at `develop`, but you still want `master`).

### One edge case

Git only allows a branch checked out in one place. If a repo's **main directory
is currently on `master`**, a second master worktree can't be created, so
`sync_master` pulls master in place in the main dir instead. It will not forcibly
move your working branch. To get the fully-separated layout, switch that repo's
main dir to develop/release first, then run `sync_master`.

## Usage examples

Scope review (read-only):
```
discover_repos(rootPath="/Users/karansinha/dataflow-dev")
```

Dry-run the master sync across everything:
```
sync_master(dryRun=true)
```

Do it for real (skips dirty repos, reports them):
```
sync_master()
```

Include dirty repos too (safe — pull happens in the isolated worktree):
```
sync_master(includeDirty=true)
```

Spin up a develop worktree for one repo:
```
create_worktree(branch="develop", repoPath="/Users/karansinha/dataflow-dev/VTP/ia-service")
```

Clean up a worktree:
```
remove_worktree(repoPath=".../ia-service", branch="master")
```

## Safety

- All git operations shell out to system `git` via `execFile` with args passed as
  an array (no shell string interpolation), so paths/branch names can't inject.
- `GIT_TERMINAL_PROMPT=0` so a repo needing credentials fails fast instead of
  hanging on a prompt.
- No force operations. `remove_worktree` protects dirty worktrees by default.
