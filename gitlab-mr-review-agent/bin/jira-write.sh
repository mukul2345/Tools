#!/usr/bin/env bash
#
# jira-write.sh — WRITE to Jira (comment / transition / create / update / link / meta).
#
# Reuses the same Basic-auth REST v3 path as the read spine (context_gather.py's JiraAuth),
# which is INDEPENDENT of the Atlassian Rovo OAuth MCP (that path fails "scope does not match").
# This launcher only loads the keychain secrets and hands off to jira_write.py.
#
# Usage:
#   ./jira-write.sh <subcommand> [args...]
# Examples:
#   ./jira-write.sh comment DT-52144 --body "Fix pushed."
#   ./jira-write.sh transition DT-52144 --list
#   ./jira-write.sh transition DT-52144 --to "In Progress"
#   ./jira-write.sh create --project DT --type Bug --summary "..." --field customfield_10841:='{"id":"10405"}'
#   ./jira-write.sh meta --project DT --type Bug
#
# Secrets (from env / macOS keychain; never hardcoded):
#   ATLASSIAN_EMAIL      (keychain item 'atlassian-email')
#   ATLASSIAN_API_TOKEN  (keychain item 'atlassian-api-token')
#   JIRA_BASE_URL        (keychain item 'jira-base-url', e.g. https://acme.atlassian.net)

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <comment|transition|create|update|link|meta> [args...]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export ATLASSIAN_EMAIL="${ATLASSIAN_EMAIL:-$(security find-generic-password -s atlassian-email -w 2>/dev/null || true)}"
export ATLASSIAN_API_TOKEN="${ATLASSIAN_API_TOKEN:-$(security find-generic-password -s atlassian-api-token -w 2>/dev/null || true)}"
export JIRA_BASE_URL="${JIRA_BASE_URL:-$(security find-generic-password -s jira-base-url -w 2>/dev/null || true)}"

: "${ATLASSIAN_EMAIL:?set ATLASSIAN_EMAIL (keychain item 'atlassian-email')}"
: "${ATLASSIAN_API_TOKEN:?set ATLASSIAN_API_TOKEN (keychain item 'atlassian-api-token')}"
: "${JIRA_BASE_URL:?set JIRA_BASE_URL (keychain item 'jira-base-url')}"

exec python3 "${SCRIPT_DIR}/../scripts/jira_write.py" "$@"
