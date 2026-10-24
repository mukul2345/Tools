#!/usr/bin/env bash
#
# fetch-jira-ticket.sh — download the COMPLETE details of a single Jira ticket.
#
# Reuses the same Basic-auth REST v3 path as the MR-review spine (context_gather.py's JiraAuth),
# which is INDEPENDENT of the Atlassian Rovo OAuth MCP (that path fails with "scope does not match").
# This script only loads the keychain secrets and hands off to fetch_jira_ticket.py.
#
# Usage:
#   ./fetch-jira-ticket.sh <TICKET_KEY> [--out DIR] [--raw]
# Examples:
#   ./fetch-jira-ticket.sh DT-49083
#   ./fetch-jira-ticket.sh DT-49083 --out ~/my-projects/narada/.local-files
#
# Secrets (from env / macOS keychain; never hardcoded):
#   ATLASSIAN_EMAIL      (keychain item 'atlassian-email')
#   ATLASSIAN_API_TOKEN  (keychain item 'atlassian-api-token')
#   JIRA_BASE_URL        (keychain item 'jira-base-url', e.g. https://acme.atlassian.net)

set -euo pipefail

KEY="${1:-}"
if [[ -z "$KEY" ]]; then
  echo "Usage: $0 <TICKET_KEY> [--out DIR] [--raw]" >&2
  exit 2
fi
shift || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export ATLASSIAN_EMAIL="${ATLASSIAN_EMAIL:-$(security find-generic-password -s atlassian-email -w 2>/dev/null || true)}"
export ATLASSIAN_API_TOKEN="${ATLASSIAN_API_TOKEN:-$(security find-generic-password -s atlassian-api-token -w 2>/dev/null || true)}"
export JIRA_BASE_URL="${JIRA_BASE_URL:-$(security find-generic-password -s jira-base-url -w 2>/dev/null || true)}"

: "${ATLASSIAN_EMAIL:?set ATLASSIAN_EMAIL (keychain item 'atlassian-email')}"
: "${ATLASSIAN_API_TOKEN:?set ATLASSIAN_API_TOKEN (keychain item 'atlassian-api-token')}"
: "${JIRA_BASE_URL:?set JIRA_BASE_URL (keychain item 'jira-base-url')}"

exec python3 "${SCRIPT_DIR}/../scripts/fetch_jira_ticket.py" "$KEY" "$@"
