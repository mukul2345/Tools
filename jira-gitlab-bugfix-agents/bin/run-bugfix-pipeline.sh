#!/usr/bin/env bash
#
# run-bugfix-pipeline.sh — run the analyze → fix pipeline for one Jira issue.
#
#   Phase 0: gather-script (Python, no LLM) builds ticket-history for the analyzer.
#   Phase 1: ONE orchestrator session (Kiro subagents) drives:
#              analyzer (Opus) → brief gate → fixer (Sonnet), all in a single session.
#
# The orchestrator agent delegates to the analyzer and fixer as subagents, so there is NO manual
# Ctrl+C / session-exit between phases — you launch one session and it runs the whole pipeline.
# Requires Kiro CLI with subagent support (1.23+). Watch subagents live with Ctrl+G.
#
# Legacy mode (--no-subagents) keeps the old two-separate-sessions behavior, where you must exit
# the analyzer session before the fixer runs.
#
# Usage:
#   ./run-bugfix-pipeline.sh DT-46133 [--prefixes DT,VP] [--scripts DIR] [--no-subagents]
#
# Secrets are read from the environment / macOS keychain (never hardcode):
#   GITLAB_PERSONAL_ACCESS_TOKEN, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN, JIRA_BASE_URL
#   KIRO_API_KEY (optional; enables headless/unattended for either mode)

set -euo pipefail

ISSUE_KEY="${1:-}"
[[ -z "$ISSUE_KEY" ]] && { echo "Usage: $0 <JIRA-ISSUE-KEY> [--prefixes DT,VP] [--scripts DIR] [--no-subagents]"; exit 2; }
shift || true

PREFIXES=""
SCRIPTS_DIR="${HOME}/my-projects/jira-bug-fixer/scripts"
USE_SUBAGENTS=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefixes) PREFIXES="$2"; shift 2 ;;
    --scripts)  SCRIPTS_DIR="$2"; shift 2 ;;
    --no-subagents) USE_SUBAGENTS=0; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

WORK="/tmp/kiro-bugfix/${ISSUE_KEY}"
BRIEF="${WORK}/implementation-brief.md"

# --- Secrets (from keychain if not already exported) ---
export GITLAB_PERSONAL_ACCESS_TOKEN="${GITLAB_PERSONAL_ACCESS_TOKEN:-$(security find-generic-password -s gitlab-pat -w 2>/dev/null || true)}"
export ATLASSIAN_EMAIL="${ATLASSIAN_EMAIL:-$(security find-generic-password -s atlassian-email -w 2>/dev/null || true)}"
export ATLASSIAN_API_TOKEN="${ATLASSIAN_API_TOKEN:-$(security find-generic-password -s atlassian-api-token -w 2>/dev/null || true)}"
export JIRA_BASE_URL="${JIRA_BASE_URL:-$(security find-generic-password -s jira-base-url -w 2>/dev/null || true)}"
: "${GITLAB_PERSONAL_ACCESS_TOKEN:?set GITLAB_PERSONAL_ACCESS_TOKEN (keychain item 'gitlab-pat')}"
: "${ATLASSIAN_EMAIL:?set ATLASSIAN_EMAIL (keychain item 'atlassian-email')}"
: "${ATLASSIAN_API_TOKEN:?set ATLASSIAN_API_TOKEN (keychain item 'atlassian-api-token')}"
: "${JIRA_BASE_URL:?set JIRA_BASE_URL (keychain item 'jira-base-url')}"

# The mcp-atlassian MCP server ("jira" in mcp.json) reads JIRA_* names — feed it the same
# keychain-derived values so the token never has to be inlined in mcp.json.
export JIRA_URL="${JIRA_URL:-$JIRA_BASE_URL}"
export JIRA_USERNAME="${JIRA_USERNAME:-$ATLASSIAN_EMAIL}"
export JIRA_API_TOKEN="${JIRA_API_TOKEN:-$ATLASSIAN_API_TOKEN}"

mkdir -p "$WORK"
echo "[pipeline] issue=$ISSUE_KEY workspace=$WORK"

# --- Phase 0: gather ticket history (deterministic, no LLM) ---
echo "[pipeline] Phase 0 — gathering ticket history"
python3 "${SCRIPTS_DIR}/jira_gather.py" "$ISSUE_KEY" --out "$WORK" \
  ${PREFIXES:+--project-prefixes "$PREFIXES"}

HEADLESS=0
[[ -n "${KIRO_API_KEY:-}" ]] && HEADLESS=1
rm -f "$BRIEF"   # clear any stale brief so the gate is honest

run_agent() {  # $1=agent  $2=prompt
  local agent="$1" prompt="$2"
  if [[ "$HEADLESS" == "1" ]]; then
    kiro-cli chat --no-interactive --agent "$agent" \
      --trust-tools=read,write,shell --require-mcp-startup "$prompt"
  else
    kiro-cli chat --agent "$agent" "$prompt"
  fi
}

if [[ "$USE_SUBAGENTS" == "1" ]]; then
  # --- Single-session pipeline via the orchestrator (no manual Ctrl+C between phases) ---
  echo "[pipeline] Phase 1 — orchestrator (analyzer → gate → fixer in one session; Ctrl+G to watch subagents)"
  run_agent "jira-bugfix-orchestrator" \
    "Run the bug-fix pipeline for Jira issue ${ISSUE_KEY}. Ticket history is at ${WORK}/ticket-history.md. Follow your run loop: delegate to jira-bug-analyzer, gate on ${WORK}/implementation-brief.md, and only if it exists delegate to jira-bug-fixer."
  echo "[pipeline] orchestrator session ended for $ISSUE_KEY"
  [[ -f "$BRIEF" ]] && echo "[pipeline] brief present — analysis aligned." \
                    || echo "[pipeline] no brief — analyzer halted at analysis (check the Jira comment)."
else
  # --- Legacy: two separate sessions (must exit the analyzer session to continue) ---
  echo "[pipeline] Phase 1 — analyzer (separate session; exit it with Ctrl+D to continue)"
  run_agent "jira-bug-analyzer" \
    "Analyze Jira issue ${ISSUE_KEY}. The ticket history is at ${WORK}/ticket-history.md. Follow your run loop exactly, including the mismatch-halt gate. Write ${WORK}/implementation-brief.md only if your independent analysis aligns with the proposal."

  if [[ ! -f "$BRIEF" ]]; then
    echo "[pipeline] HALT — no implementation-brief.md produced (mismatch or could not proceed). Fixer will NOT run."
    exit 0
  fi
  echo "[pipeline] gate passed — implementation brief present."

  echo "[pipeline] Phase 2 — fixer (implement approved brief)"
  run_agent "jira-bug-fixer" \
    "Fix Jira issue ${ISSUE_KEY}. Your spec is the approved brief at ${WORK}/implementation-brief.md (spec_source=analyzer). Follow your run loop exactly, including the autonomy gate, the Step 5.5 compliance gate, and the STOP conditions."
fi

echo "[pipeline] done for $ISSUE_KEY"
