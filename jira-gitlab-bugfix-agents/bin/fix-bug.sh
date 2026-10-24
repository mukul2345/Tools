#!/usr/bin/env bash
#
# fix-bug.sh — one-liner entry point: paste a Jira URL (or a bare key) and go.
#
#   ./fix-bug.sh https://dataflowplus.atlassian.net/browse/DT-49255
#   ./fix-bug.sh DT-49255
#   ./fix-bug.sh DT-49255 --no-subagents          # extra args pass through
#   DRY_RUN=1 ./fix-bug.sh <url>                  # print what would run, do nothing
#
# Wraps run-bugfix-pipeline.sh: extracts the issue key from the URL, ensures kiro-cli is on
# PATH, and applies the default project prefixes. Override prefixes with PREFIXES=DT,VP,XX.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INPUT="${1:-}"
if [[ -z "$INPUT" ]]; then
  echo "Usage: $0 <JIRA-URL-or-KEY> [extra args for run-bugfix-pipeline.sh]" >&2
  echo "   e.g. $0 https://dataflowplus.atlassian.net/browse/DT-49255" >&2
  exit 2
fi
shift || true

# Accept a full browse//issues URL, a URL with a query string or trailing slash, or a bare key.
ISSUE_KEY="$(printf '%s' "$INPUT" | grep -oE '[A-Z][A-Z0-9_]+-[0-9]+' | head -1 || true)"
if [[ -z "$ISSUE_KEY" ]]; then
  echo "Could not find a Jira issue key (e.g. DT-49255) in: $INPUT" >&2
  exit 2
fi

# kiro-cli lives in ~/.local/bin, which isn't always on a non-login shell's PATH.
export PATH="$HOME/.local/bin:$PATH"
command -v kiro-cli >/dev/null 2>&1 || { echo "kiro-cli not found on PATH" >&2; exit 1; }

PREFIXES="${PREFIXES:-DT,VP}"

echo "[fix-bug] issue=$ISSUE_KEY prefixes=$PREFIXES"
if [[ -n "${DRY_RUN:-}" ]]; then
  echo "[fix-bug] DRY_RUN — would run:"
  echo "          $HERE/run-bugfix-pipeline.sh $ISSUE_KEY --prefixes $PREFIXES $*"
  exit 0
fi

exec "$HERE/run-bugfix-pipeline.sh" "$ISSUE_KEY" --prefixes "$PREFIXES" "$@"
