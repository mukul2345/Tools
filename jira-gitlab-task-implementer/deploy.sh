#!/usr/bin/env bash
#
# deploy.sh — install the Jira→GitLab task-implementer onto this machine.
# Portable & idempotent: run it from the repo root after cloning.
#
#   ./deploy.sh
#
# It copies the agent/steering/scripts/runner into ~/.kiro and ~/my-projects/jira-task-implementer,
# substituting the __KIRO_HOME__ placeholder in the agent config with YOUR home directory, so the
# same repo works for every teammate. It does NOT touch secrets.

set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

KIRO_HOME="$HOME/.kiro"
PROJ="$HOME/my-projects/jira-task-implementer"
mkdir -p "$KIRO_HOME/agents" "$KIRO_HOME/steering" "$KIRO_HOME/settings" "$PROJ/scripts" "$PROJ/config"

echo "==> Agent + prompt + MR process -> $KIRO_HOME/agents"
# Agent JSONs: substitute the portable placeholder with the real home path.
# `rm -f` first so a re-run overwrites even a read-only target (dir is writable; file mode isn't).
for f in "$SRC"/agents/*.json; do
  dest="$KIRO_HOME/agents/$(basename "$f")"
  rm -f "$dest"
  sed "s#__KIRO_HOME__#$KIRO_HOME#g" "$f" > "$dest"
done
# Prompts + resources (MR process): copy verbatim. `cp -f` removes + recreates a read-only target
# (e.g. merge-request-process-vpt.md may have been installed read-only by a sibling agent's deploy).
cp -f "$SRC"/agents/*.md "$KIRO_HOME/agents/"

echo "==> Steering -> $KIRO_HOME/steering"
cp -f "$SRC"/steering/*.md "$KIRO_HOME/steering/"

echo "==> MCP config -> $KIRO_HOME/settings/mcp.json"
if [ -f "$KIRO_HOME/settings/mcp.json" ]; then
  echo "    (exists — NOT overwriting your mcp.json; diff against config/mcp.example.json manually)"
else
  cp "$SRC"/config/mcp.example.json "$KIRO_HOME/settings/mcp.json"
  echo "    Installed from example. EDIT it: set your own local paths for workflow-mcp-server"
  echo "    (dist/index.js), the uvx path, and AWS_PROFILE — these are per-developer."
fi

echo "==> Scripts -> $PROJ/scripts"
cp -f "$SRC"/scripts/*.py "$PROJ/scripts/"

echo "==> Example run config -> $PROJ/config"
cp -f "$SRC"/config/run.example.yml "$PROJ/config/"

echo "==> Runner -> $PROJ"
cp -f "$SRC"/bin/*.sh "$PROJ/"
chmod +x "$PROJ"/*.sh

echo "==> Validating agent"
kiro-cli version || true
kiro-cli agent validate --path "$KIRO_HOME/agents/task-implementer.json"
kiro-cli agent list || true

cat <<EOF

==> Done. Before your first run, make sure these keychain items exist:
      security add-generic-password -s gitlab-pat          -a "\$USER" -w
      security add-generic-password -s atlassian-email     -a "\$USER" -w
      security add-generic-password -s atlassian-api-token -a "\$USER" -w
      security add-generic-password -s jira-base-url       -a "\$USER" -w

   Then copy the example config, fill it in, and run:
      cd $PROJ
      cp config/run.example.yml config/run.yml
      \$EDITOR config/run.yml
      ./run-task-implementer.sh --config config/run.yml
EOF
