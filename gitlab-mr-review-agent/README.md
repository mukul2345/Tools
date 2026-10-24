# GitLab MR-Review Agent

Reviews one GitLab merge request, or several related MRs (one story across services), end to end
on **Kiro CLI**. A **deterministic Python spine** owns the sequence and every mechanical check
(diff fetch, lint/type-check, changed-test coverage, call-graph impact map, Jira context). The
model runs only for the semantic review, as headless stages:
**find (parallel, recall) → verify (fresh context, precision) → gap sweep (deep only)**. The
model never posts; a deterministic REST step posts everything.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

```
MR URL(s) ─► per MR: fetch ─► submission ─► context ─► clone ─► build ─► static ─► coverage ─► impact ─► input
                                                                                                        │
             change set (all MRs + --seed intent + --related context-only MRs)  ◄──────────────────────┘
                 │
                 ├─ FIND    logic │ tests │ integration (multi-MR)   — Sonnet, parallel, headless
                 ├─ MERGE   ground in each MR's diff, dedupe          — code
                 ├─ VERIFY  confirm/reject + confidence 0-100         — Opus, fresh context
                 ├─ GAP     "what was missed?" → verified too         — deep only
                 └─ APPLY   keep CONFIRMED ≥ threshold → per-MR review.md
                                                                            │
             per MR: review_finalize.py ─► post-plan.json ─► review_post.py (posts everything) ─► cleanup
```

## Install (once per machine)

It ships as the npm package `@dfg/mr-review` on the same private `@dfg` registry every VPT repo
already installs from, so your existing `~/.npmrc` is all the auth it needs — no clone, no extra
token for the install.

```bash
npm i -g @dfg/mr-review          # then: mr-review --help
npm i -g @dfg/mr-review@latest   # update
npx -y @dfg/mr-review@latest <MR_URL> --dry-run   # or run without installing
```

Once a day, `mr-review` checks the registry (one `npm view`, 3 s timeout, cached) and prints a
one-line notice when a newer version exists. It never installs anything or blocks a run; set
`MR_REVIEW_NO_UPDATE_CHECK=1` to turn it off.

Secrets live in the macOS keychain. The first `mr-review` run from a terminal walks you through
them (GitLab PAT with `api` scope, plus optional Atlassian email / API token / Jira URL); macOS
prompts for each value, so nothing lands in shell history or a file. Later:

```bash
mr-review setup           # add whatever is missing
mr-review setup --reset   # replace stored values (e.g. after rotating a token)
```

Without a terminal (scripts/CI) it never prompts: it falls back to the `@dfg` registry token in
`~/.npmrc` (fetching works; posting fails if that token is `read_api` only) or exits with a hint.

Also needs: Kiro CLI logged in (`kiro-cli whoami`), git, Node ≥ 18 + pnpm, Python 3, macOS.

## Run

```bash
# one MR
mr-review https://gitlab.com/org/repo/-/merge_requests/123

# one story across services: reviewed together, comments land on each MR
mr-review <lib-MR> <service-A-MR> <service-B-MR> \
    --seed "Adds X to the contract; service A emits it, service B validates it" \
    --related <already-merged-MR-for-context>

# preview everything, post nothing
mr-review <MR> --dry-run

mr-review --help      # all flags      mr-review --version
```

**Your own defaults** (like `git config`; saved in `~/.config/mr-review/config.json`):

```bash
mr-review config set find-model claude-sonnet-5.5     # model ids are checked against kiro-cli
mr-review config set verify-model claude-opus-5.5
mr-review config set parallel 2                       # keys: find-model verify-model depth threshold parallel engine
mr-review config list    |   mr-review config unset parallel
```

Precedence: command-line flag > `KIRO_MR_*` env var > `mr-review config` > built-in default.

| Flag | Meaning |
| --- | --- |
| `<MR_URL> ...` | One or more MRs. Several = one change set, with a cross-MR integration finder |
| `--seed TEXT` / `--seed-file F` | Author intent. Reviewers check the code actually achieves it |
| `--related URL` (repeatable) | Context-only MR: read by the reviewers, never commented on |
| `--depth quick\|standard\|deep` | `quick` = 1 pass, no verify. `standard` (default) = finder(s) + verifier: one checklist finder for a single MR, logic/tests/integration finders for a change set. `deep` = + gap sweep |
| `--find-model` / `--verify-model` | Defaults `claude-sonnet-5.5` / `claude-opus-5.5` (env `KIRO_MR_FIND_MODEL` / `KIRO_MR_VERIFY_MODEL`) |
| `--threshold N` | Minimum verifier confidence to post (default 70) |
| `--parallel N` | Max concurrent kiro-cli stage sessions (default 3; lower it when memory is tight) |
| `--engine v2\|v3` | kiro-cli agent engine (default `v2`, see below) |
| `--dry-run` / `--no-post` | Show what would post / skip posting |
| `--force` | Redo everything. Each step saves its output and re-running the same MR(s) reuses it (fast, free); use `--force` after new commits on the MR |
| `--from STEP`, `--keep`, `--no-agent` | Start at a step reusing earlier output (e.g. `--from review` re-runs only the model stages) / keep clones / prep only |

Every step and every model stage checkpoints a file, so `--from review` re-runs only the model
stages (and only the ones whose output is missing).

## Outputs

Per MR, in `/tmp/kiro-mr-review/<repo>-<iid>/`: the prep files (`mr.json`, `full.diff`,
`changed-index.json`, `static-findings.*`, `coverage-report.md`, `impact-map.md`,
`jira-context.md`, `review-input.md`), then `review.md` (verified findings + assessment),
`review-final.md` (human report, including what the verifier rejected and why),
`post-plan.json`, `posted.json`.

Per change set, in `/tmp/kiro-mr-review/cs-<hash>/`: `changeset.md` (what every stage reads
first), `related/`, `find-*.md`, `candidates.md`, `verify.md`, `gap.md`, `run/` (exact stage
instructions), `logs/` (each kiro-cli session), and `.kiro/agents/` (the workspace-local profile).

## Credits

Every model stage runs with `--output-format stream-json`; the spine sums its `meteringUsage`
and prints a per-stage table at the end of the run (also appended to each MR's
`review-final.md` and saved as `<cs>/credits.md` / `credits.json`):

```
| stage            | model             | credits | time |
| find-logic       | claude-sonnet-5.5 | …       | …    |
| verify           | claude-opus-5.5   | …       | …    |
| total            |                   | …       |      |
```

Several MRs reviewed together share the stages, so the table is per change set, with an average
per MR. Deterministic steps cost 0 credits; a re-run that reuses a stage's output shows it as
`reused (0 this run)`.

## Run records (monitoring)

Every run — success, failure or Ctrl-C — writes one JSON record: `<cs>/run.json`, plus one line
appended to `~/.local/state/mr-review/runs.jsonl` (override with `MR_REVIEW_STATE_DIR`). It holds
the tool version, options, outcome and failed step, duration, per-MR results (build, static
findings, verdict, comments posted or would-post on `--dry-run`), finding counts
(raw → candidates → confirmed / rejected) and per-stage credits. Stage fields use the
OpenTelemetry GenAI names (`gen_ai.agent.name`, `gen_ai.request.model`) so a CloudWatch or OTLP
exporter can map them directly. Nothing leaves the machine yet.

```bash
tail -1 ~/.local/state/mr-review/runs.jsonl | python3 -m json.tool
```

## What gets posted

Everything, with no menu (team feedback):

- **Inline**: CRITICAL/HIGH findings anchored to a changed line (snapped onto the nearest diff line).
- **Summary note**: business-logic assessment, regression risks, cross-MR integration (multi-MR),
  findings that couldn't be anchored, verdict, action items, and LOW findings collapsed in one
  `Nits (N)` block. LOW findings are never posted inline.
- **Coverage**: one consolidated comment when coverage regresses.

Re-posting is a no-op unless `--force`. Post a prepared plan manually with
`python3 scripts/review_post.py --ws <workspace> [--dry-run]`.

## Noise controls

- ESLint core rules that TypeScript owns (`no-undef`, `no-redeclare`, `no-dupe-class-members`,
  `no-unused-vars`) are ignored on `.ts` files. This removes the `describe`/`it`/`expect` "is not
  defined" flood. `tsc` still runs, so a really undefined name is still reported.
- The same rule firing many times in one file becomes one finding listing the lines.
- Static findings are scoped to changed lines; LOW is capped and never inline.
- The verifier rejects false positives, pre-existing issues and nits before anything posts.

## kiro-cli engine

The spine runs `kiro-cli chat --no-interactive` with a workspace-local profile
(`agents/mr-reviewer.json`, materialised into each change-set dir), so nothing is installed into
`~/.kiro/agents`. The profile carries both V2 fields (`allowedTools`, `toolsSettings`) and the V3
`permissions` block, with relative `file://./` URIs (V3 rejects absolute prompt URIs).

**Default is `v2`** because, on kiro-cli 2.30, a probe showed V2 enforces the profile's write-path
restriction headlessly while V3 needs `--trust-tools=fs_write` to write at all and then did not
enforce the profile's `fs_write` scope for a workspace-local profile. Switch with `--engine v3` /
`KIRO_MR_ENGINE=v3` once that is verified on your version.

## Guardrails

- The stage agent has read tools plus a write tool limited to `/tmp/kiro-mr-review/**`; shell is
  read-only (`cat`, `grep`, `git log/show/diff/blame` …) and denies `curl`/`wget`/`python`/`node`,
  `git` writes, `rm`, and anything with a token or `/api/v4/`. It cannot post, push or merge.
- Every finding must cite a changed `file:line` and evidence; ungrounded findings are dropped in
  code before verification and again in finalize.
- The verdict is recomputed from severity counts in code; it is advisory only.

## Releasing / developing

- Release: bump `version` in `package.json`, push to master, then press ▶ on the manual
  `publish-mr-review` job in that pipeline (or CI/CD → Pipelines → Run pipeline on master). The
  `@dfg` registry only accepts the CI `NPM_TOKEN`, so `npm publish` from a laptop is rejected with
  "Package protected". The automatic `test-mr-review` job runs `npm test` first; there is no build
  step because nothing is compiled — the files in `package.json` "files" ship as they are.
- Develop: `npm install` in this folder, then `node bin/mr-review.js <MR_URL> --dry-run`.
  `npm test` runs the offline self-tests.

Self-tests (offline): `python3 scripts/review_stages.py`, `python3 scripts/review_finalize.py`,
`python3 scripts/review_static_gate.py`, `python3 scripts/review_post.py --selftest`.
