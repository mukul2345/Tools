# coverage-table-generator

Clones each **service** repo from GitLab, pulls the latest of its default branch,
runs its tests with coverage, and produces a UT coverage table as **CSV** and **Markdown**.

Package repos and internal tools from the source list are intentionally excluded —
only the 17 services are covered.

## Layout

```
coverage-table-generator/
├── repos.config       # the service list (name | gitlab-path | team | branch)
├── parse-coverage.js  # reads an Istanbul coverage report -> percentages
├── run.sh             # orchestrator: clone/pull -> test+coverage -> CSV+MD
├── .env.example       # copy to .env to override defaults
├── workspace/         # (generated) cloned repos, reused across runs
└── output/            # (generated) coverage-<date>.csv / .md + per-repo *.log
```

## Prerequisites

- `git`, `node`, and one of `pnpm` / `yarn` / `npm` (auto-detected per repo)
- **Clone access** to the repos. Two options:
  - SSH (default): your GitLab SSH key must be loaded (`ssh -T git@gitlab.com`)
  - HTTPS: set `CLONE_PROTO=https` and `GITLAB_TOKEN=<read_repository PAT>` in `.env`

## Usage

```bash
cp .env.example .env        # optional — defaults work for SSH

./run.sh                    # all services in repos.config
./run.sh --only "poi-service verification-request"
./run.sh --no-pull          # use whatever is already on disk (no fetch/pull)
./run.sh --skip-tests       # reuse existing coverage/ dirs, just re-tabulate
```

Output lands in `output/coverage-<YYYY-MM-DD>.csv` and `.md`. Per-repo install/test
logs are in `output/<repo>.log` — check these when a repo shows `Status = no-report`.

## How coverage is measured

`run.sh` runs each repo's own coverage script (auto-detected from `package.json`:
`test:coverage`, `test:cov`, `coverage`, or any script containing `--coverage`/`nyc`/`c8`),
appending `--coverageReporters=json-summary json` so an Istanbul summary is always emitted.
`parse-coverage.js` then reads, in order:

1. `coverage/coverage-summary.json` (has `total` — used directly)
2. `coverage/coverage-final.json` (per-file counters — totalled ourselves)

Reported columns: **Lines %, Branches %, Functions %, Statements %**.

If a repo uses a non-standard command, set `COVERAGE_CMD` in `.env` (applies to all),
or adjust that repo's `package.json` script.

## Fixing a failed clone

A few GitLab slugs in `repos.config` are best-guesses (marked `# TODO`). If a repo
prints `CLONE FAILED`, open the repo in GitLab, copy the path after `gitlab.com/`,
and replace the `<gitlab-path>` field for that line. Re-run with
`./run.sh --only "<that-repo>"`.

## Notes

- Runs are **idempotent**: repos are cloned once into `workspace/` and reused;
  subsequent runs just `fetch` + `pull --ff-only`.
- Non-zero test exit codes don't abort the batch — a repo with failing tests still
  gets tabulated if it produced a coverage report (status `ok`), otherwise `no-report`.
