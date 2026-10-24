#!/usr/bin/env bash
# ============================================================
# coverage-table-generator/run.sh
# ------------------------------------------------------------
# For each SERVICE repo in repos.config:
#   1. clone from GitLab (or reuse existing checkout)
#   2. checkout + pull latest of its default branch
#   3. install deps and run tests with coverage
#   4. parse the Istanbul coverage report
# Then write a coverage table to output/coverage-<date>.csv and .md
#
# Usage:
#   ./run.sh                 # all repos in repos.config
#   ./run.sh --only "poi-service verification-request"
#   ./run.sh --skip-tests    # reuse existing coverage/ dirs, just re-tabulate
#   ./run.sh --no-pull       # don't fetch/pull, use whatever is on disk
#
# Config: copy .env.example -> .env to override CLONE_PROTO, GITLAB_TOKEN,
# WORKDIR, OUTDIR, INSTALL_CMD, COVERAGE_CMD.
# ============================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- load config ---
[ -f "$SCRIPT_DIR/.env" ] && set -a && . "$SCRIPT_DIR/.env" && set +a
# shellcheck source=repos.config
. "$SCRIPT_DIR/repos.config"

CLONE_PROTO="${CLONE_PROTO:-ssh}"
WORKDIR="${WORKDIR:-$SCRIPT_DIR/workspace}"
OUTDIR="${OUTDIR:-$SCRIPT_DIR/output}"
GITLAB_HOST="gitlab.com"

SKIP_TESTS=0
NO_PULL=0
ONLY=""

while [ $# -gt 0 ]; do
    case "$1" in
        --only) ONLY="$2"; shift 2 ;;
        --skip-tests) SKIP_TESTS=1; shift ;;
        --no-pull) NO_PULL=1; shift ;;
        -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

mkdir -p "$WORKDIR" "$OUTDIR"

DATE="$(date +%Y-%m-%d)"
CSV="$OUTDIR/coverage-$DATE.csv"
MD="$OUTDIR/coverage-$DATE.md"

# Colours (no-op if not a tty)
if [ -t 1 ]; then B="\033[1m"; G="\033[32m"; Y="\033[33m"; R="\033[31m"; N="\033[0m"; else B=""; G=""; Y=""; R=""; N=""; fi

log()  { printf "%b\n" "$*"; }
info() { printf "%b\n" "${B}$*${N}"; }
ok()   { printf "%b\n" "${G}$*${N}"; }
warn() { printf "%b\n" "${Y}$*${N}"; }
err()  { printf "%b\n" "${R}$*${N}" >&2; }

clone_url() {
    local path="$1"
    if [ "$CLONE_PROTO" = "https" ]; then
        if [ -n "${GITLAB_TOKEN:-}" ]; then
            echo "https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${path}.git"
        else
            echo "https://${GITLAB_HOST}/${path}.git"
        fi
    else
        echo "git@${GITLAB_HOST}:${path}.git"
    fi
}

# Detect the package manager from the lockfile in $1
detect_install() {
    local dir="$1"
    if [ -n "${INSTALL_CMD:-}" ]; then echo "$INSTALL_CMD"; return; fi
    if   [ -f "$dir/pnpm-lock.yaml" ]; then echo "pnpm install --frozen-lockfile"
    elif [ -f "$dir/yarn.lock" ];      then echo "yarn install --frozen-lockfile"
    elif [ -f "$dir/package-lock.json" ]; then echo "npm ci"
    else echo "npm install"; fi
}

# Pick a coverage command. Prefer an explicit script in package.json; else
# fall back to a jest/vitest coverage run forcing the json-summary reporter.
detect_coverage_cmd() {
    local dir="$1"
    if [ -n "${COVERAGE_CMD:-}" ]; then echo "$COVERAGE_CMD"; return; fi
    local pkg="$dir/package.json"
    [ -f "$pkg" ] || { echo ""; return; }
    # Look for a coverage-ish script name, in priority order.
    local found
    found="$(node -e '
        const s=(require(process.argv[1]).scripts)||{};
        const names=["test:coverage","test:cov","coverage","cov","test:ci"];
        for(const n of names){ if(s[n]){console.log(n);process.exit(0);} }
        // any script whose body mentions --coverage
        for(const [n,body] of Object.entries(s)){ if(/--coverage|nyc|c8/.test(body)){console.log(n);process.exit(0);} }
    ' "$pkg" 2>/dev/null)"
    if [ -n "$found" ]; then
        # Append json-summary so parse-coverage always has totals (Jest & vitest accept the flag).
        echo "npm run $found -- --coverageReporters=json-summary --coverageReporters=json"
        return
    fi
    # Last resort: assume jest is available.
    echo "npx jest --coverage --coverageReporters=json-summary --coverageReporters=json --passWithNoTests"
}

process_repo() {
    local name="$1" gpath="$2" team="$3" branch="$4"
    local dir="$WORKDIR/$name"

    info "\n=== $name  ($team, $branch) ==="

    if [ "$NO_PULL" -eq 1 ] && [ ! -d "$dir/.git" ]; then
        warn "  no checkout and --no-pull set, skipping clone"
    elif [ ! -d "$dir/.git" ]; then
        local url; url="$(clone_url "$gpath")"
        log "  cloning $gpath ..."
        if ! git clone --quiet "$url" "$dir"; then
            err "  CLONE FAILED (check slug in repos.config): $gpath"
            RESULTS+=("$name|$team|$branch|NA|NA|NA|NA|clone-failed")
            return
        fi
    fi

    if [ "$NO_PULL" -eq 0 ] && [ -d "$dir/.git" ]; then
        log "  checkout $branch + pull ..."
        git -C "$dir" fetch --quiet origin "$branch" 2>/dev/null
        git -C "$dir" checkout --quiet "$branch" 2>/dev/null || warn "  branch '$branch' checkout failed"
        git -C "$dir" pull --quiet --ff-only origin "$branch" 2>/dev/null || warn "  pull skipped"
    fi

    if [ "$SKIP_TESTS" -eq 0 ]; then
        local install cov
        install="$(detect_install "$dir")"
        log "  install: $install"
        ( cd "$dir" && eval "$install" ) >>"$OUTDIR/$name.log" 2>&1 || warn "  install had errors (see $name.log)"

        cov="$(detect_coverage_cmd "$dir")"
        if [ -z "$cov" ]; then
            err "  no coverage command resolved"
            RESULTS+=("$name|$team|$branch|NA|NA|NA|NA|no-coverage-cmd")
            return
        fi
        log "  coverage: $cov"
        ( cd "$dir" && eval "$cov" ) >>"$OUTDIR/$name.log" 2>&1 || warn "  tests reported failures (coverage may still exist; see $name.log)"
    fi

    local parsed lines branches functions statements status
    parsed="$(node "$SCRIPT_DIR/parse-coverage.js" "$dir")"
    IFS='|' read -r lines branches functions statements <<<"$parsed"
    if [ "$lines" = "NA" ] && [ "$statements" = "NA" ]; then
        status="no-report"
        warn "  no coverage report found"
    else
        status="ok"
        ok "  lines=$lines% branches=$branches% functions=$functions% statements=$statements%"
    fi
    RESULTS+=("$name|$team|$branch|$lines|$branches|$functions|$statements|$status")
}

# --- run ---
RESULTS=()
for entry in "${REPOS[@]}"; do
    # strip trailing "# comment" and surrounding whitespace
    entry="${entry%%#*}"
    entry="$(echo "$entry" | sed 's/[[:space:]]*$//')"
    [ -z "$entry" ] && continue
    IFS='|' read -r name gpath team branch <<<"$entry"
    if [ -n "$ONLY" ] && ! grep -qw "$name" <<<"$ONLY"; then continue; fi
    process_repo "$name" "$gpath" "$team" "$branch"
done

# --- write CSV ---
{
    echo "#,Service,Team,Branch,Lines %,Branches %,Functions %,Statements %,Status"
    i=0
    for row in "${RESULTS[@]}"; do
        i=$((i+1))
        IFS='|' read -r name team branch lines branches functions statements status <<<"$row"
        echo "$i,$name,$team,$branch,$lines,$branches,$functions,$statements,$status"
    done
} >"$CSV"

# --- write Markdown ---
{
    echo "# UT Coverage — $DATE"
    echo
    echo "| # | Service | Team | Branch | Lines % | Branches % | Functions % | Statements % | Status |"
    echo "|---|---------|------|--------|---------|------------|-------------|--------------|--------|"
    i=0
    for row in "${RESULTS[@]}"; do
        i=$((i+1))
        IFS='|' read -r name team branch lines branches functions statements status <<<"$row"
        echo "| $i | $name | $team | $branch | $lines | $branches | $functions | $statements | $status |"
    done
} >"$MD"

info "\nWrote:"
ok "  $CSV"
ok "  $MD"
