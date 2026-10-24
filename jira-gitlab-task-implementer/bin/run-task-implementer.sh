#!/usr/bin/env bash
#
# run-task-implementer.sh — thin launcher for the deterministic task-implementer spine.
#
# All orchestration lives in scripts/run_task_pipeline.py: a code driver runs
#   preflight -> clone -> select -> branch -> implement(LLM) -> coverage -> compliance -> report,
# calling the LLM at only ONE node (the implement step). This script's only job is to load secrets
# from the macOS keychain and hand off to the spine.
#
# Usage:
#   ./run-task-implementer.sh --config run.yml [--jira DT-1] [--branch NAME] [--model opus]
#                             [--force] [--from STEP] [--fresh] [--cleanup] [--scripts DIR]
#
#   --fresh    wipe this run's workspace before starting (start clean instead of resuming).
#   --cleanup  remove the workspace after a successful run (status: implemented).
#   (By default the workspace under /tmp/kiro-task/<jira>/<branch>/ is KEPT so a re-run resumes
#    at the first missing step and you can inspect artifacts. Stopping the agent does NOT delete
#    it — the agent absorbs Ctrl+C, so use --fresh to start clean.)
#
# Secrets are read from the environment / macOS keychain (never hardcode):
#   GITLAB_PERSONAL_ACCESS_TOKEN   (git clone + the agent's push)
#   ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN / JIRA_BASE_URL   (Jira preflight + the agent's comment)
#   KIRO_API_KEY (optional; when set, the spine runs the implement agent headless/non-interactive)

set -euo pipefail

# Default to the deployed scripts dir; override with --scripts for local/dev runs.
SCRIPTS_DIR="${HOME}/my-projects/jira-task-implementer/scripts"
CONFIG=""
PASSTHRU=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)  CONFIG="$2"; shift 2 ;;
    --scripts) SCRIPTS_DIR="$2"; shift 2 ;;
    *)         PASSTHRU+=("$1"); shift ;;   # --jira/--branch/--model/--force/--from -> spine
  esac
done

if [[ -z "$CONFIG" ]]; then
  echo "Usage: $0 --config <run.yml> [--jira DT-1] [--branch NAME] [--model opus] [--force] [--from STEP] [--scripts DIR]" >&2
  exit 2
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "run config not found: $CONFIG" >&2
  exit 2
fi

# --- Secrets (from keychain if not already exported) ---
export GITLAB_PERSONAL_ACCESS_TOKEN="${GITLAB_PERSONAL_ACCESS_TOKEN:-$(security find-generic-password -s gitlab-pat -w 2>/dev/null || true)}"
export ATLASSIAN_EMAIL="${ATLASSIAN_EMAIL:-$(security find-generic-password -s atlassian-email -w 2>/dev/null || true)}"
export ATLASSIAN_API_TOKEN="${ATLASSIAN_API_TOKEN:-$(security find-generic-password -s atlassian-api-token -w 2>/dev/null || true)}"
export JIRA_BASE_URL="${JIRA_BASE_URL:-$(security find-generic-password -s jira-base-url -w 2>/dev/null || true)}"
: "${GITLAB_PERSONAL_ACCESS_TOKEN:?set GITLAB_PERSONAL_ACCESS_TOKEN (keychain item 'gitlab-pat')}"
: "${ATLASSIAN_EMAIL:?set ATLASSIAN_EMAIL (keychain item 'atlassian-email')}"
: "${ATLASSIAN_API_TOKEN:?set ATLASSIAN_API_TOKEN (keychain item 'atlassian-api-token')}"
: "${JIRA_BASE_URL:?set JIRA_BASE_URL (keychain item 'jira-base-url')}"

# When an API key is present, run the implement agent headless (non-interactive). Otherwise it runs
# interactively against your normal `kiro-cli login` session (works even if API keys are disabled).
HEADLESS_FLAG=()
if [[ -n "${KIRO_API_KEY:-}" ]]; then
  HEADLESS_FLAG=(--headless)
else
  kiro-cli whoami >/dev/null 2>&1 || { echo "Not logged in and no KIRO_API_KEY. Run: kiro-cli login"; exit 1; }
fi

echo "[run-task-implementer] config=$CONFIG scripts=$SCRIPTS_DIR ${HEADLESS_FLAG[*]:-interactive}"
# NOTE: `${arr[@]+"${arr[@]}"}` expands to nothing when the array is empty — required because
# macOS ships bash 3.2, where `"${arr[@]}"` on an empty array trips `set -u` ("unbound variable").
exec python3 "${SCRIPTS_DIR}/run_task_pipeline.py" --config "$CONFIG" \
  ${HEADLESS_FLAG[@]+"${HEADLESS_FLAG[@]}"} ${PASSTHRU[@]+"${PASSTHRU[@]}"}
