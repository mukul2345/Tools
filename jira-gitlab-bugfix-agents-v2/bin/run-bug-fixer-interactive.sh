#!/usr/bin/env bash
#
# run-bug-fixer-interactive.sh — run the jira-bug-fixer agent WITHOUT a Kiro API key.
# Uses your normal `kiro-cli login` session (interactive), so it works even when the
# org has API-key generation disabled. You approve any tool call not already pre-approved
# in the agent's allowedTools.
#
# Usage:
#   ./run-bug-fixer-interactive.sh DT-46133
#
# Only GitLab needs a secret here (Kiro auth comes from your login session).

set -euo pipefail

ISSUE_KEY="${1:-}"
if [[ -z "$ISSUE_KEY" ]]; then
  echo "Usage: $0 <JIRA-ISSUE-KEY>   e.g. $0 DT-46133" >&2
  exit 2
fi

# GitLab token from the keychain (see SETUP.md Phase 1). No KIRO_API_KEY required.
export GITLAB_PERSONAL_ACCESS_TOKEN="${GITLAB_PERSONAL_ACCESS_TOKEN:-$(security find-generic-password -s gitlab-pat -w)}"
: "${GITLAB_PERSONAL_ACCESS_TOKEN:?Set GITLAB_PERSONAL_ACCESS_TOKEN or store it as keychain item 'gitlab-pat'}"

# Make sure you're logged in (no API key needed for interactive).
kiro-cli whoami >/dev/null 2>&1 || { echo "Not logged in. Run: kiro-cli login"; exit 1; }

# The agent clones into a deterministic per-issue workspace it manages itself
# (/tmp/kiro-bugfix/<ISSUE-KEY>) and cleans it up on success — see the agent prompt Steps 3 & 9.
# Each shell call the agent makes is independent, so we don't rely on this script's CWD.
echo "[run-bug-fixer] issue=$ISSUE_KEY  (clone workspace: /tmp/kiro-bugfix/${ISSUE_KEY})"

# Interactive launch. Tools in the agent's allowedTools auto-approve; anything else prompts you.
# Add --trust-tools=read,write,shell if you want fewer prompts once you trust the loop.
kiro-cli chat \
  --agent jira-bug-fixer \
  "Fix the bug described in Jira issue ${ISSUE_KEY}. Follow your run loop exactly, including the autonomy gate and the STOP conditions."

echo "[run-bug-fixer] session ended for $ISSUE_KEY"
echo "[run-bug-fixer] if it STOPped early, inspect: /tmp/kiro-bugfix/${ISSUE_KEY}"
