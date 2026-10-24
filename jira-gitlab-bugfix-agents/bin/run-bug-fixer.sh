#!/usr/bin/env bash
#
# run-bug-fixer.sh — kick off the jira-bug-fixer agent for one Jira issue.
#
# Usage:
#   ./run-bug-fixer.sh DT-46133
#
# Secrets are read from the environment. Do NOT hardcode them here.
# Recommended: load them from your OS keychain / secret manager, e.g.
#   export KIRO_API_KEY="$(security find-generic-password -s kiro-api-key -w)"
#   export GITLAB_PERSONAL_ACCESS_TOKEN="$(security find-generic-password -s gitlab-pat -w)"

set -euo pipefail

ISSUE_KEY="${1:-}"
if [[ -z "$ISSUE_KEY" ]]; then
  echo "Usage: $0 <JIRA-ISSUE-KEY>   e.g. $0 DT-46133" >&2
  exit 2
fi

# --- Required secrets (must already be exported in the environment) ---
: "${KIRO_API_KEY:?Set KIRO_API_KEY (headless auth) before running}"
: "${GITLAB_PERSONAL_ACCESS_TOKEN:?Set GITLAB_PERSONAL_ACCESS_TOKEN before running}"

# Jira creds for the mcp-atlassian MCP server ("jira" in mcp.json), from the same keychain items.
export JIRA_URL="${JIRA_URL:-$(security find-generic-password -s jira-base-url -w 2>/dev/null || true)}"
export JIRA_USERNAME="${JIRA_USERNAME:-$(security find-generic-password -s atlassian-email -w 2>/dev/null || true)}"
export JIRA_API_TOKEN="${JIRA_API_TOKEN:-$(security find-generic-password -s atlassian-api-token -w 2>/dev/null || true)}"

# --- Isolated scratch workspace per run (agent clones repos here) ---
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/bugfix-${ISSUE_KEY}.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"

echo "[run-bug-fixer] issue=$ISSUE_KEY workdir=$WORKDIR"

# --- Invoke Kiro headless with the custom agent ---
# --trust-tools grants only the categories the loop needs (least privilege).
# Tool-level auto-approval is already scoped in the agent's allowedTools.
# --require-mcp-startup fails fast if Jira/GitLab MCP can't connect.
kiro-cli chat \
  --no-interactive \
  --agent jira-bug-fixer \
  --trust-tools=read,write,shell \
  --require-mcp-startup \
  "Fix the bug described in Jira issue ${ISSUE_KEY}. Follow your run loop exactly, including the autonomy gate and the STOP conditions."

echo "[run-bug-fixer] done for $ISSUE_KEY"
