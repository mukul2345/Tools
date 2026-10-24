#!/usr/bin/env bash
#
# run-autopilot.sh — per-job driver for the proactive-error-analyser autopilot.
#
# Input: a single job file (JSON) emitted by run-autopilot.ts, containing
#   { issueId, service, endpoint, severity, category, buildP1TicketInput, prefixes }
#
# What it does (out-of-process, background-safe):
#   1. Uses kiro-cli (which has the MCP bridge + keychain) to:
#        a. call the `build_p1_ticket` MCP tool with buildP1TicketInput, then
#        b. call `jira_create_issue` with the returned jira_create_issue_args,
#        c. print the created issue KEY on a line "CREATED_ISSUE=<KEY>".
#   2. Triggers jira-gitlab-bugfix-agents-v2 headless on that KEY, which reads the
#      ticket's KIRO-EXEC block, runs its own analyzer to devise a fix, and opens
#      a GitLab MR (autonomy=auto-mr → create+push, never merge).
#
# Secrets are read from env / macOS keychain (never hardcoded) — the bugfix
# launcher itself pulls gitlab-pat / atlassian-email / atlassian-api-token /
# jira-base-url. KIRO_API_KEY must be set for headless agent runs.
#
# Usage:
#   bash bin/run-autopilot.sh /path/to/<issueId>.job.json
#
# Env overrides:
#   KIRO_CLI               kiro-cli binary (default: kiro-cli)
#   KIRO_AGENT             agent used for the MCP ticket-creation step (default: default)
#   BUGFIX_LAUNCHER        path to run-bugfix-pipeline.sh
#                          (default: ../jira-gitlab-bugfix-agents-v2/bin/run-bugfix-pipeline.sh)
#   BUGFIX_SCRIPTS         --scripts dir for the bugfix pipeline
#                          (default: ../jira-gitlab-bugfix-agents-v2/scripts)

set -euo pipefail

JOB_FILE="${1:-}"
[[ -z "$JOB_FILE" || ! -f "$JOB_FILE" ]] && { echo "Usage: $0 <job-file.json>"; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYSER_DIR="$(cd "$HERE/.." && pwd)"
TOOLBOX_DIR="$(cd "$ANALYSER_DIR/.." && pwd)"

KIRO_CLI="${KIRO_CLI:-kiro-cli}"
KIRO_AGENT="${KIRO_AGENT:-}"
BUGFIX_LAUNCHER="${BUGFIX_LAUNCHER:-$TOOLBOX_DIR/jira-gitlab-bugfix-agents-v2/bin/run-bugfix-pipeline.sh}"
BUGFIX_SCRIPTS="${BUGFIX_SCRIPTS:-$TOOLBOX_DIR/jira-gitlab-bugfix-agents-v2/scripts}"

# Durable audit record: one JSON line per job, written next to the job file
# (autopilot/<runId>/results.jsonl). Records the created/existing ticket key,
# the fingerprint, the bugfix exit status, and a timestamp — so the ticket key
# survives even if the terminal output is lost.
RESULTS_FILE="$(dirname "$JOB_FILE")/../results.jsonl"
append_result() {
  # $1=status $2=issueKey $3=note
  node -e '
    const fs=require("fs");
    const [file,status,issueKey,note,job]=process.argv.slice(1);
    const j=JSON.parse(fs.readFileSync(job,"utf8"));
    fs.appendFileSync(file, JSON.stringify({
      ts:new Date().toISOString(), status, issueKey,
      service:j.service, endpoint:j.endpoint, severity:j.severity,
      category:j.category, fingerprint:j.fingerprintLabel, note
    })+"\n");
  ' "$RESULTS_FILE" "$1" "$2" "$3" "$JOB_FILE" 2>/dev/null || true
}

PREFIXES="$(node -e 'const j=require(process.argv[1]);process.stdout.write(j.prefixes||"DT")' "$JOB_FILE")"

echo "── Autopilot job: $JOB_FILE"
echo "   prefixes=$PREFIXES  agent=$KIRO_AGENT"

# ------------------------------------------------------------------
# Step 1: create the Jira ticket through the MCP bridge via kiro-cli.
# We hand kiro-cli a precise instruction + the buildP1TicketInput payload and
# ask it to (a) call build_p1_ticket, (b) forward jira_create_issue_args to
# jira_create_issue, (c) echo the created key.
# ------------------------------------------------------------------
FINGERPRINT="$(node -e 'const j=require(process.argv[1]);process.stdout.write(j.fingerprintLabel||"")' "$JOB_FILE")"

# Build the prompt with node (writes to a temp file) rather than a shell heredoc.
# The P1 input JSON contains quotes/backticks/parens and possibly a line that
# looks like a heredoc terminator, which broke shell parsing when interpolated.
# node handles all escaping safely.
PROMPT_FILE="$(mktemp -t autopilot-prompt.XXXXXX)"
trap 'rm -f "$PROMPT_FILE"' EXIT
PROMPT_FILE="$PROMPT_FILE" node -e '
  const fs = require("fs");
  const [job] = process.argv.slice(1);
  const j = JSON.parse(fs.readFileSync(job, "utf8"));
  const fp = j.fingerprintLabel || "";
  const project = (j.buildP1TicketInput && j.buildP1TicketInput.project) || "DT";
  const p1 = JSON.stringify(j.buildP1TicketInput);
  const prompt = [
    "You are running headless in an automation pipeline. Do EXACTLY these steps and nothing else:",
    "",
    "STEP 0 (DEDUP — do this FIRST):",
    "Call the MCP tool jira_search with this JQL to find an existing ticket for this same error fingerprint:",
    `  jql: project = ${project} AND labels = "${fp}" AND statusCategory != Done ORDER BY created DESC`,
    "If it returns one or more issues, DO NOT create a new one. Print this single line and STOP:",
    "  EXISTING_ISSUE=<the existing issue key>",
    "Only if the search returns ZERO issues, continue to step 1.",
    "",
    "STEP 1: Call the MCP tool build_p1_ticket with this exact argument object:",
    p1,
    "STEP 2: Take the returned jira_create_issue_args and call the MCP tool jira_create_issue with those arguments VERBATIM (additional_fields is already a JSON string; components is a comma string if present). If the project rejects the create for missing mandatory fields, discover valid values and retry, but keep summary/description/labels verbatim (the labels include the fingerprint \"" + fp + "\" — preserve it).",
    "STEP 3: After the issue is created, print one final line in EXACTLY this format and nothing after it:",
    "CREATED_ISSUE=<the new issue key>",
    "",
    `Create at most ONE issue. Do not attempt to fix code in this step. The fingerprint label "${fp}" MUST be present on any ticket you create so future runs can dedup on it.`,
  ].join("\n");
  fs.writeFileSync(process.env.PROMPT_FILE, prompt);
' "$JOB_FILE"
PROMPT="$(cat "$PROMPT_FILE")"

echo "── Step 1: dedup-check + create P1 ticket via kiro-cli MCP bridge (fingerprint=${FINGERPRINT})..."
# Build the kiro-cli args. --no-interactive requires --trust-all-tools to
# auto-approve MCP tool calls (per the CLI: "tool permission approval is not
# supported in non-interactive mode"). Only pass --agent when KIRO_AGENT is set
# to a non-default value, since an unavailable named agent errors ("failed to
# set agent").
KIRO_ARGS=(chat --no-interactive --trust-all-tools)
if [[ -n "${KIRO_AGENT:-}" && "${KIRO_AGENT}" != "default" ]]; then
  KIRO_ARGS+=(--agent "$KIRO_AGENT")
fi

CREATE_OUT="$(
  "$KIRO_CLI" "${KIRO_ARGS[@]}" "$PROMPT" 2>&1
)" || { echo "$CREATE_OUT"; echo "❌ ticket creation failed"; exit 1; }

echo "$CREATE_OUT"
# A re-run finds the existing ticket (EXISTING_ISSUE=); a first run creates one
# (CREATED_ISSUE=). Either way we proceed to the bugfix step on that key.
EXISTING_KEY="$(printf '%s\n' "$CREATE_OUT" | grep -oE 'EXISTING_ISSUE=[A-Z]+-[0-9]+' | tail -n1 | cut -d= -f2 || true)"
NEW_KEY="$(printf '%s\n' "$CREATE_OUT" | grep -oE 'CREATED_ISSUE=[A-Z]+-[0-9]+' | tail -n1 | cut -d= -f2 || true)"
ISSUE_KEY="${NEW_KEY:-$EXISTING_KEY}"

if [[ -z "$ISSUE_KEY" ]]; then
  echo "❌ Could not parse an issue key (expected 'CREATED_ISSUE=<KEY>' or 'EXISTING_ISSUE=<KEY>'). Aborting bugfix trigger."
  exit 1
fi
if [[ -n "$EXISTING_KEY" && -z "$NEW_KEY" ]]; then
  echo "↩️  Duplicate skipped — existing ticket $ISSUE_KEY matches fingerprint $FINGERPRINT. No new ticket created."
  append_result "duplicate_skipped" "$ISSUE_KEY" "matched fingerprint $FINGERPRINT"
else
  echo "✅ Created ticket: $ISSUE_KEY"
  append_result "ticket_created" "$ISSUE_KEY" "fingerprint $FINGERPRINT"
fi
echo "📝 Result logged to: $RESULTS_FILE"

# ------------------------------------------------------------------
# Step 2: trigger the bugfix agent headless on the new ticket.
# It reads the ticket's KIRO-EXEC block, runs its own analyzer (no human
# solution on the ticket → analyzer path), implements the fix, and opens the MR.
# ------------------------------------------------------------------
echo "── Step 2: triggering jira-gitlab-bugfix-agents-v2 on $ISSUE_KEY ..."
if [[ -z "${KIRO_API_KEY:-}" ]]; then
  echo "⚠️  KIRO_API_KEY is not set — the bugfix pipeline will run INTERACTIVE, not headless."
fi

bash "$BUGFIX_LAUNCHER" "$ISSUE_KEY" --scripts "$BUGFIX_SCRIPTS" --prefixes "$PREFIXES" && BUGFIX_RC=0 || BUGFIX_RC=$?

if [[ "${BUGFIX_RC:-0}" -eq 0 ]]; then
  echo "✅ Bugfix pipeline finished for $ISSUE_KEY (see /tmp/kiro-bugfix/$ISSUE_KEY/ for artifacts + MR)."
  append_result "bugfix_completed" "$ISSUE_KEY" "artifacts at /tmp/kiro-bugfix/$ISSUE_KEY/"
else
  echo "⚠️  Bugfix pipeline for $ISSUE_KEY exited with status $BUGFIX_RC (may be a STOP gate — see output above)."
  append_result "bugfix_stopped" "$ISSUE_KEY" "exit $BUGFIX_RC — see /tmp/kiro-bugfix/$ISSUE_KEY/"
fi
echo "📝 Final result logged to: $RESULTS_FILE"
