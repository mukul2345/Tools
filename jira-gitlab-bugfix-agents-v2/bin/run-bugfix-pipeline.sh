#!/usr/bin/env bash
#
# run-bugfix-pipeline.sh — thin launcher for the deterministic bug-fix spine.
#
# All orchestration lives in scripts/run_pipeline.py (see docs/ORCHESTRATION-AUDIT.md): a code
# driver runs gather -> resolve -> analyze -> gate -> fix -> coverage -> compliance -> report,
# calling the LLM at only two nodes (analyzer, fixer). This script's ONLY job is to load secrets
# from the macOS keychain and hand off to the spine. The former Haiku orchestrator and the
# legacy two-session (--no-subagents) mode have been retired.
#
# Usage:
#   ./run-bugfix-pipeline.sh DT-46133 [--prefixes DT,VP] [--scripts DIR] [--force] [--from STEP]
#
# Secrets are read from the environment / macOS keychain (never hardcode):
#   GITLAB_PERSONAL_ACCESS_TOKEN, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN, JIRA_BASE_URL
#   KIRO_API_KEY (optional; when set, the spine runs the agents headless/non-interactive)

set -euo pipefail

ISSUE_KEY="${1:-}"
[[ -z "$ISSUE_KEY" ]] && { echo "Usage: $0 <JIRA-ISSUE-KEY> [--prefixes DT,VP] [--scripts DIR] [--force] [--from STEP]"; exit 2; }
shift || true

# Default to the deployed scripts dir; override with --scripts for local/dev runs.
SCRIPTS_DIR="${HOME}/my-projects/jira-bug-fixer/scripts"
PASSTHRU=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scripts) SCRIPTS_DIR="$2"; shift 2 ;;
    *) PASSTHRU+=("$1"); shift ;;   # --prefixes/--force/--from/--headless -> spine
  esac
done

# --- Secrets (from keychain if not already exported) ---
export GITLAB_PERSONAL_ACCESS_TOKEN="${GITLAB_PERSONAL_ACCESS_TOKEN:-$(security find-generic-password -s gitlab-pat -w 2>/dev/null || true)}"
export ATLASSIAN_EMAIL="${ATLASSIAN_EMAIL:-$(security find-generic-password -s atlassian-email -w 2>/dev/null || true)}"
export ATLASSIAN_API_TOKEN="${ATLASSIAN_API_TOKEN:-$(security find-generic-password -s atlassian-api-token -w 2>/dev/null || true)}"
export JIRA_BASE_URL="${JIRA_BASE_URL:-$(security find-generic-password -s jira-base-url -w 2>/dev/null || true)}"
: "${GITLAB_PERSONAL_ACCESS_TOKEN:?set GITLAB_PERSONAL_ACCESS_TOKEN (keychain item 'gitlab-pat')}"
: "${ATLASSIAN_EMAIL:?set ATLASSIAN_EMAIL (keychain item 'atlassian-email')}"
: "${ATLASSIAN_API_TOKEN:?set ATLASSIAN_API_TOKEN (keychain item 'atlassian-api-token')}"
: "${JIRA_BASE_URL:?set JIRA_BASE_URL (keychain item 'jira-base-url')}"

# When an API key is present, run the agents headless (non-interactive).
HEADLESS_FLAG=()
[[ -n "${KIRO_API_KEY:-}" ]] && HEADLESS_FLAG=(--headless)

exec python3 "${SCRIPTS_DIR}/run_pipeline.py" "$ISSUE_KEY" ${HEADLESS_FLAG[@]+"${HEADLESS_FLAG[@]}"} ${PASSTHRU[@]+"${PASSTHRU[@]}"}
