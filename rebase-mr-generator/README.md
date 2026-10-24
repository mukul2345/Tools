# rebase-mr-generator

Automates the **back-merge / rebase-sync** step across many repos, then hands
off to [`../gitlab-mr-generator`](../gitlab-mr-generator) to raise the MRs.

## The problem it solves

When `release` is ahead of `develop`, a `develop → release` MR shows
**"needs rebase"** because release has commits develop doesn't. The fix is a
**back-merge**: record `release` into `develop` first. After that, the
`develop → release` MR is clean.

Because `develop` is protected, we don't push it directly. Instead, per repo we:

1. cut a throwaway **sync branch** from `origin/<target>` (e.g. `develop`)
2. **merge** `origin/<source>` (e.g. `release`) into it
3. **push** the sync branch
4. raise an MR `sync-branch → <target>` (via `create_mr.js`)

## Merge strategies

- **`ours`** (default) — records the merge with **zero content changes**. The
  sync branch tree equals the target tree, so the MR shows **0 file changes**
  but git still records source as merged (fixes the "needs rebase" tracking).
  Use when develop is already functionally in sync and you only need the
  git ancestry link. No conflicts possible.
- **`recursive`** — a real 3-way content merge that actually brings source's
  changes in. May produce conflicts; the script leaves the repo mid-merge for
  you to resolve, `git add`, commit, and push.

## Repo discovery

You pass repo **names only** — never paths. The script finds each repo on disk
by searching, in order:

- `<dataflow-repo>/VTP/<name>`
- `<dataflow-repo>/<name>`

(both derived automatically from the script's own location). Override via
`SEARCH_ROOTS` in `rebase-mr.config` if your layout differs.

## Configuration (`rebase-mr.config`)

Defaults live here — branches, strategy, sync-branch name template, push
behavior, and the default repo list. Everything is overridable on the CLI.

## Usage

```bash
# defaults from rebase-mr.config (release → develop, strategy ours)
./rebase-mr.sh

# choose which branch → which branch
./rebase-mr.sh --source release --target develop

# real content merge instead of a 0-change record merge
./rebase-mr.sh --strategy recursive

# default repos PLUS extra ones
./rebase-mr.sh --add "ops-service ia-service"

# ONLY these repos (ignore defaults)
./rebase-mr.sh --only "verification-request poi-service"

# explicit sync branch name (e.g. tie to a ticket)
./rebase-mr.sh --branch sync/rel-to-dev-DT-123

# merge locally but don't push
./rebase-mr.sh --no-push

# recreate/overwrite an existing sync branch (force-push with lease)
./rebase-mr.sh --force

# preview only, change nothing
./rebase-mr.sh --dry-run
```

## Then raise the MRs

After a run, the summary prints the exact command. It targets the sibling
generator, using the sync branch as the MR source:

```bash
cd ../gitlab-mr-generator
node create_mr.js --config mrs.yml --source "sync/release-to-develop-YYYYMMDD" --target "develop"
```

`create_mr.js` reads the repo list + assignees/reviewers from `mrs.yml`. Keep
the two repo lists (this tool's `DEFAULT_REPOS` and `mrs.yml`'s `projects`) in
sync so every pushed sync branch gets an MR.

## Safety notes

- Skips repos with a dirty working tree (won't clobber local changes).
- `--no-verify` on push (default) skips local pre-push hooks that build/test;
  the MR's CI still runs. Set `NO_VERIFY=0` in the config to keep hooks.
- Never pushes the target branch directly.
- Force-push (`--force`) uses `--force-with-lease`.
