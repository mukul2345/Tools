#!/bin/bash
#
# rebase-mr.sh — flexible back-merge / rebase-sync across many repos.
#
# For each repo it: cuts a sync branch from TARGET_BRANCH, merges
# SOURCE_BRANCH into it (strategy configurable), and pushes the sync
# branch. You then raise MRs (sync-branch -> TARGET_BRANCH) with the
# sibling gitlab-mr-generator/create_mr.js.
#
# Repos are located automatically on disk by name (across VTP/ and the
# dataflow-repo root), so you only ever pass repo NAMES, never paths.
#
# Usage:
#   ./rebase-mr.sh                                  # defaults from rebase-mr.config
#   ./rebase-mr.sh --source release --target develop
#   ./rebase-mr.sh --strategy recursive             # real content merge
#   ./rebase-mr.sh --add "ops-service ia-service"   # defaults + extra repos
#   ./rebase-mr.sh --only "verification-request"    # just these repos
#   ./rebase-mr.sh --branch sync/rel-to-dev-DT-123  # explicit sync branch name
#   ./rebase-mr.sh --no-push                        # merge locally, don't push
#   ./rebase-mr.sh --force                          # force-push if branch exists
#   ./rebase-mr.sh --dry-run                        # show plan, change nothing
#
set +e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/rebase-mr.config"

# ---- load config ----
[ -f "$CONFIG_FILE" ] && source "$CONFIG_FILE"
: "${SOURCE_BRANCH:=release}"; : "${TARGET_BRANCH:=develop}"
: "${MERGE_STRATEGY:=ours}"; : "${SYNC_BRANCH_TEMPLATE:=sync/{source}-to-{target}-{date}}"
: "${PUSH:=1}"; : "${FORCE:=0}"; : "${NO_VERIFY:=1}"; : "${REMOTE:=origin}"
: "${DRY_RUN:=0}"
[ ${#DEFAULT_REPOS[@]} -eq 0 ] && DEFAULT_REPOS=()

# ---- derive search roots from script location if not set ----
if [ ${#SEARCH_ROOTS[@]} -eq 0 ]; then
    DATAFLOW_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"   # <dataflow-repo>
    SEARCH_ROOTS=( "$DATAFLOW_ROOT/VTP" "$DATAFLOW_ROOT" )
fi

# ---- CLI parsing ----
REPOS=(); ADD_REPOS=(); ONLY_MODE=0; EXPLICIT_BRANCH=""
usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -40; exit 0; }
while [ $# -gt 0 ]; do
    case "$1" in
        --source) SOURCE_BRANCH="$2"; shift 2;;
        --target) TARGET_BRANCH="$2"; shift 2;;
        --strategy) MERGE_STRATEGY="$2"; shift 2;;
        --branch) EXPLICIT_BRANCH="$2"; shift 2;;
        --add) read -r -a ADD_REPOS <<< "$2"; shift 2;;
        --only) read -r -a REPOS <<< "$2"; ONLY_MODE=1; shift 2;;
        --no-push) PUSH=0; shift;;
        --push) PUSH=1; shift;;
        --force) FORCE=1; shift;;
        --dry-run) DRY_RUN=1; shift;;
        -h|--help) usage;;
        *) echo -e "${RED}Unknown arg: $1${NC}"; exit 2;;
    esac
done

# Build the effective repo list
if [ "$ONLY_MODE" -eq 0 ]; then
    REPOS=( "${DEFAULT_REPOS[@]}" "${ADD_REPOS[@]}" )
fi

# Resolve sync branch name
if [ -n "$EXPLICIT_BRANCH" ]; then
    SYNC_BRANCH="$EXPLICIT_BRANCH"
else
    SYNC_BRANCH="$SYNC_BRANCH_TEMPLATE"
    SYNC_BRANCH="${SYNC_BRANCH//\{source\}/$SOURCE_BRANCH}"
    SYNC_BRANCH="${SYNC_BRANCH//\{target\}/$TARGET_BRANCH}"
    SYNC_BRANCH="${SYNC_BRANCH//\{date\}/$(date +%Y%m%d)}"
fi

case "$MERGE_STRATEGY" in
    ours) GIT_MERGE_ARGS=(-s ours);;
    recursive|ort|"") GIT_MERGE_ARGS=();;
    *) echo -e "${RED}Unknown strategy: $MERGE_STRATEGY (use 'ours' or 'recursive')${NC}"; exit 2;;
esac

# ---- helpers ----
locate_repo() {
    local name="$1" root
    for root in "${SEARCH_ROOTS[@]}"; do
        [ -d "$root/$name/.git" ] && { echo "$root/$name"; return 0; }
    done
    return 1
}
is_clean() { [ -z "$(git -C "$1" status --porcelain)" ]; }
rbranch_exists() { git -C "$1" show-ref --verify --quiet "refs/remotes/$REMOTE/$2"; }
lbranch_exists() { git -C "$1" show-ref --verify --quiet "refs/heads/$2"; }

# ---- result buckets ----
PUSHED=(); MERGED_NOPUSH=(); UPTODATE=(); CONFLICT=(); SKIP_DIRTY=(); SKIP_MISSING=(); SKIP_NOBRANCH=(); SKIP_EXISTS=(); FAILED=()

# ---- per-repo processing ----
process_repo() {
    local name="$1"
    echo -e "${BLUE}📦 ${name}${NC}"

    local repo; repo=$(locate_repo "$name")
    if [ -z "$repo" ]; then
        echo -e "   ${YELLOW}⚠️  not found under: ${SEARCH_ROOTS[*]}${NC}"; SKIP_MISSING+=("$name"); echo ""; return
    fi
    echo "   path: $repo"

    if [ "$DRY_RUN" = "1" ]; then
        echo -e "   ${BLUE}[dry-run]${NC} would: branch $SYNC_BRANCH off $REMOTE/$TARGET_BRANCH, merge (${MERGE_STRATEGY}) $REMOTE/$SOURCE_BRANCH, $([ "$PUSH" = 1 ] && echo push || echo 'no push')"
        echo ""; return
    fi

    if ! is_clean "$repo"; then
        echo -e "   ${YELLOW}⚠️  working tree dirty — skipping (commit/stash/clean first)${NC}"; SKIP_DIRTY+=("$name"); echo ""; return
    fi

    git -C "$repo" fetch --prune "$REMOTE" >/dev/null 2>&1
    rbranch_exists "$repo" "$SOURCE_BRANCH" || { echo -e "   ${YELLOW}⚠️  $REMOTE/$SOURCE_BRANCH missing${NC}"; SKIP_NOBRANCH+=("$name"); echo ""; return; }
    rbranch_exists "$repo" "$TARGET_BRANCH" || { echo -e "   ${YELLOW}⚠️  $REMOTE/$TARGET_BRANCH missing${NC}"; SKIP_NOBRANCH+=("$name"); echo ""; return; }

    # Handle a pre-existing local sync branch.
    if lbranch_exists "$repo" "$SYNC_BRANCH"; then
        if [ "$FORCE" = "1" ]; then
            git -C "$repo" checkout "$TARGET_BRANCH" >/dev/null 2>&1
            git -C "$repo" branch -D "$SYNC_BRANCH" >/dev/null 2>&1
        else
            echo -e "   ${YELLOW}⚠️  local branch $SYNC_BRANCH exists — skipping (use --force to recreate)${NC}"; SKIP_EXISTS+=("$name"); echo ""; return
        fi
    fi

    echo "   creating $SYNC_BRANCH off $REMOTE/$TARGET_BRANCH"
    if ! git -C "$repo" checkout -b "$SYNC_BRANCH" "$REMOTE/$TARGET_BRANCH" >/dev/null 2>&1; then
        echo -e "   ${RED}❌ could not create branch${NC}"; FAILED+=("$name"); echo ""; return
    fi

    echo "   merging $REMOTE/$SOURCE_BRANCH (strategy: $MERGE_STRATEGY)"
    git -C "$repo" merge --no-edit "${GIT_MERGE_ARGS[@]}" -m "Merge $REMOTE/$SOURCE_BRANCH into $TARGET_BRANCH (rebase-sync)" "$REMOTE/$SOURCE_BRANCH" >/tmp/rmr_m 2>&1
    local rc=$?; local out; out=$(cat /tmp/rmr_m 2>/dev/null)

    if [ $rc -eq 0 ]; then
        if echo "$out" | grep -qi "Already up to date"; then
            echo -e "   ${GREEN}✓ already up to date — no MR needed${NC}"
            git -C "$repo" checkout "$TARGET_BRANCH" >/dev/null 2>&1
            git -C "$repo" branch -D "$SYNC_BRANCH" >/dev/null 2>&1
            UPTODATE+=("$name"); echo ""; return
        fi
        local delta; delta=$(git -C "$repo" diff --shortstat "$REMOTE/$TARGET_BRANCH" HEAD)
        echo -e "   ${GREEN}✅ merged${NC} (${delta:-0 file changes})"
        push_branch "$repo" "$name"
    else
        if [ -n "$(git -C "$repo" ls-files -u)" ]; then
            echo -e "   ${YELLOW}⚠️  CONFLICT — left mid-merge for manual resolution:${NC}"
            git -C "$repo" diff --name-only --diff-filter=U | sed 's/^/      - /'
            echo -e "   ${YELLOW}    resolve in $repo, then: git add … && git commit && git push${NC}"
            CONFLICT+=("$name")
        else
            echo -e "   ${RED}❌ merge failed:${NC}"; echo "$out" | tail -3 | sed 's/^/      /'
            git -C "$repo" merge --abort >/dev/null 2>&1
            git -C "$repo" checkout "$TARGET_BRANCH" >/dev/null 2>&1
            git -C "$repo" branch -D "$SYNC_BRANCH" >/dev/null 2>&1
            FAILED+=("$name")
        fi
    fi
    echo ""
}

push_branch() {
    local repo="$1" name="$2"
    if [ "$PUSH" != "1" ]; then
        echo -e "   ${YELLOW}⏸️  not pushing (--no-push)${NC}"; MERGED_NOPUSH+=("$name")
        git -C "$repo" checkout "$TARGET_BRANCH" >/dev/null 2>&1; return
    fi
    local args=(push -u); [ "$NO_VERIFY" = "1" ] && args+=(--no-verify); [ "$FORCE" = "1" ] && args+=(--force-with-lease)
    if git -C "$repo" "${args[@]}" "$REMOTE" "$SYNC_BRANCH" >/tmp/rmr_p 2>&1; then
        echo -e "   ${GREEN}⬆️  pushed — ready for MR: $SYNC_BRANCH → $TARGET_BRANCH${NC}"; PUSHED+=("$name")
    else
        echo -e "   ${RED}❌ push failed:${NC}"; tail -2 /tmp/rmr_p | sed 's/^/      /'; MERGED_NOPUSH+=("$name (push failed)")
    fi
    git -C "$repo" checkout "$TARGET_BRANCH" >/dev/null 2>&1
}

plist() { local label="$1" color="$2"; shift 2; local a=("$@"); [ ${#a[@]} -gt 0 ] && { echo -e "${color}${label}: ${#a[@]}${NC}"; printf '   - %s\n' "${a[@]}"; }; }

summary() {
    echo "============================================================"
    echo -e "${BLUE}📊 Summary — $SOURCE_BRANCH → $SYNC_BRANCH (target: $TARGET_BRANCH, strategy: $MERGE_STRATEGY)${NC}"
    echo "============================================================"
    plist "⬆️  Pushed (ready for MR)" "$GREEN" "${PUSHED[@]}"
    plist "✅ Merged, not pushed" "$GREEN" "${MERGED_NOPUSH[@]}"
    plist "✓  Already up to date" "$GREEN" "${UPTODATE[@]}"
    plist "⚠️  Conflicts (mid-merge)" "$YELLOW" "${CONFLICT[@]}"
    plist "⚠️  Skipped (dirty)" "$YELLOW" "${SKIP_DIRTY[@]}"
    plist "⚠️  Skipped (not found)" "$YELLOW" "${SKIP_MISSING[@]}"
    plist "⚠️  Skipped (branch missing)" "$YELLOW" "${SKIP_NOBRANCH[@]}"
    plist "⚠️  Skipped (sync branch exists)" "$YELLOW" "${SKIP_EXISTS[@]}"
    plist "❌ Failed" "$RED" "${FAILED[@]}"
    echo "============================================================"
    if [ ${#PUSHED[@]} -gt 0 ]; then
        echo -e "${BLUE}➡️  Raise the MRs with the sibling generator:${NC}"
        echo "   cd $SCRIPT_DIR/../gitlab-mr-generator"
        echo "   node create_mr.js --config mrs.yml --source \"$SYNC_BRANCH\" --target \"$TARGET_BRANCH\""
    fi
    [ ${#CONFLICT[@]} -gt 0 ] && echo -e "${YELLOW}⚠️  Resolve conflict repos, push their $SYNC_BRANCH, then include them in the MR run.${NC}"
}

# ---- main ----
echo -e "${BLUE}🔀 rebase-mr — back-merge $SOURCE_BRANCH into $TARGET_BRANCH via $SYNC_BRANCH${NC}"
echo "   strategy=$MERGE_STRATEGY  push=$([ $PUSH = 1 ] && echo yes || echo no)  force=$([ $FORCE = 1 ] && echo yes || echo no)  dry-run=$([ $DRY_RUN = 1 ] && echo yes || echo no)"
echo "   roots: ${SEARCH_ROOTS[*]}"
echo "   repos (${#REPOS[@]}): ${REPOS[*]}"
echo ""
if [ "$DRY_RUN" != "1" ]; then
    printf "Proceed? [y/N]: "; read confirm </dev/tty
    case "$confirm" in y|Y) ;; *) echo "Aborted."; exit 0;; esac
    echo ""
fi
for r in "${REPOS[@]}"; do process_repo "$r"; done
summary
