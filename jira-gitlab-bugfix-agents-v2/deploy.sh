#!/usr/bin/env bash
#
# deploy.sh — install the Jira→GitLab bug-fixer agents onto this machine.
# Portable & idempotent: run it from the repo root after cloning.
#
#   ./deploy.sh
#
# It copies agents/steering/scripts/runners into ~/.kiro and ~/my-projects/jira-bug-fixer,
# substituting the __KIRO_HOME__ placeholder in the agent configs with YOUR home directory,
# so the same repo works for every teammate. It does NOT touch secrets.

set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

KIRO_HOME="$HOME/.kiro"
PROJ="$HOME/my-projects/jira-bug-fixer"
mkdir -p "$KIRO_HOME/agents" "$KIRO_HOME/steering" "$KIRO_HOME/settings" "$PROJ/scripts"

echo "==> Agents + prompts + template + repo map + MR process -> $KIRO_HOME/agents"
# Agent JSONs: substitute the portable placeholder with the real home path.
for f in "$SRC"/agents/*.json; do
  sed "s#__KIRO_HOME__#$KIRO_HOME#g" "$f" > "$KIRO_HOME/agents/$(basename "$f")"
done
# Prompts + resources: copy verbatim.
cp "$SRC"/agents/*.md "$KIRO_HOME/agents/"

echo "==> Steering -> $KIRO_HOME/steering"
cp "$SRC"/steering/*.md "$KIRO_HOME/steering/"

echo "==> MCP config -> $KIRO_HOME/settings/mcp.json"
if [ -f "$KIRO_HOME/settings/mcp.json" ]; then
  echo "    (exists — NOT overwriting your mcp.json; diff against config/mcp.example.json manually)"
else
  cp "$SRC"/config/mcp.example.json "$KIRO_HOME/settings/mcp.json"
  echo "    Installed from example. EDIT it: set your own local paths for workflow-mcp-server"
  echo "    (dist/index.js), the uvx path, and AWS_PROFILE — these are per-developer."
fi

echo "==> Scripts -> $PROJ/scripts"
cp "$SRC"/scripts/*.py "$PROJ/scripts/"

echo "==> Runners -> $PROJ"
cp "$SRC"/bin/*.sh "$PROJ/"
chmod +x "$PROJ"/*.sh

echo "==> Validating agents"
kiro-cli version || true
for a in jira-bug-analyzer jira-bug-fixer unit-test-writer; do
  kiro-cli agent validate --path "$KIRO_HOME/agents/$a.json"
done
kiro-cli agent list || true

cat <<'EOF'

==> Done. Before your first run, make sure these keychain items exist:
      security add-generic-password -s gitlab-pat          -a "$USER" -w
      security add-generic-password -s atlassian-email     -a "$USER" -w
      security add-generic-password -s atlassian-api-token -a "$USER" -w
      security add-generic-password -s jira-base-url       -a "$USER" -w

   Then run:
      cd ~/my-projects/jira-bug-fixer
      ./run-bugfix-pipeline.sh DT-XXXXX --prefixes DT,VP
EOF
