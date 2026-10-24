#!/usr/bin/env bash
#
# run-unit-test-writer.sh — run the unit-test-writer agent interactively.
# Clones a repo, reads source files, and writes comprehensive unit tests
# following VPT guidelines.
#
# Usage:
#   ./run-unit-test-writer.sh <repo> <source-file> [--open-mr] [--branch <name>]
#
# Examples:
#   ./run-unit-test-writer.sh verification-workflow-engine src/handler/Dependency/DependencyHandler.ts
#   ./run-unit-test-writer.sh verification-request src/modules/claimItem/ClaimItemService.ts --open-mr
#   ./run-unit-test-writer.sh applicant-service src/modules/applicant/ApplicantService.ts --branch develop
#
# Multiple files:
#   ./run-unit-test-writer.sh verification-workflow-engine \
#     "src/handler/Dependency/DependencyHandler.ts, src/handler/Dependency/IACreationTaskHandlerV2.ts"

set -euo pipefail

REPO="${1:-}"
SOURCE_FILES="${2:-}"
shift 2 2>/dev/null || true

if [[ -z "$REPO" || -z "$SOURCE_FILES" ]]; then
  echo "Usage: $0 <repo> <source-file(s)> [--open-mr] [--branch <name>]" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  $0 verification-workflow-engine src/handler/Dependency/DependencyHandler.ts" >&2
  echo "  $0 verification-request src/modules/claimItem/ClaimItemService.ts --open-mr" >&2
  echo "  $0 applicant-service src/modules/applicant/ApplicantService.ts --branch develop" >&2
  exit 2
fi

# Parse optional flags
OPEN_MR=""
BRANCH=""
TARGET_COVERAGE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --open-mr)
      OPEN_MR="--open-mr"
      shift
      ;;
    --branch)
      BRANCH="--branch $2"
      shift 2
      ;;
    --target-coverage)
      TARGET_COVERAGE="--target-coverage $2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

# GitLab token from the keychain
export GITLAB_PERSONAL_ACCESS_TOKEN="${GITLAB_PERSONAL_ACCESS_TOKEN:-$(security find-generic-password -s gitlab-pat -w)}"
: "${GITLAB_PERSONAL_ACCESS_TOKEN:?Set GITLAB_PERSONAL_ACCESS_TOKEN or store it as keychain item 'gitlab-pat'}"

# Make sure you're logged in
kiro-cli whoami >/dev/null 2>&1 || { echo "Not logged in. Run: kiro-cli login"; exit 1; }

echo "[unit-test-writer] repo=$REPO  files=$SOURCE_FILES"
echo "[unit-test-writer] workspace: /tmp/kiro-tests/${REPO}"
[[ -n "$OPEN_MR" ]] && echo "[unit-test-writer] mode: will open MR" || echo "[unit-test-writer] mode: local-only"

# Build the prompt
PROMPT="Write unit tests for the following source file(s) in repo '${REPO}': ${SOURCE_FILES}"
[[ -n "$BRANCH" ]] && PROMPT="$PROMPT $BRANCH"
[[ -n "$OPEN_MR" ]] && PROMPT="$PROMPT $OPEN_MR"
[[ -n "$TARGET_COVERAGE" ]] && PROMPT="$PROMPT $TARGET_COVERAGE"
PROMPT="$PROMPT. Follow your run loop exactly."

kiro-cli chat \
  --agent unit-test-writer \
  "$PROMPT"

echo "[unit-test-writer] session ended for $REPO"
echo "[unit-test-writer] inspect results at: /tmp/kiro-tests/${REPO}"
