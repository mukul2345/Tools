#!/usr/bin/env bash
# =============================================================================
# mr-review-cleanup.sh
# Removes the git worktree created by mr-review-prep.sh
#
# Usage:
#   ./mr-review-cleanup.sh <repo-name> <source-branch>
#
# Example:
#   ./mr-review-cleanup.sh apollo-service feat/DMW-1234-add-validation
# =============================================================================

set -euo pipefail

PROJECTS_ROOT="/Users/ravitejag/my-projects"
REPO_NAME="${1:?Usage: mr-review-cleanup.sh <repo-name> <source-branch>}"
SOURCE_BRANCH="${2:?Usage: mr-review-cleanup.sh <repo-name> <source-branch>}"

REPO_DIR="$PROJECTS_ROOT/$REPO_NAME"
SAFE_BRANCH="${SOURCE_BRANCH//\//-}"
WORKTREE_DIR="$PROJECTS_ROOT/mr-review-${REPO_NAME}-${SAFE_BRANCH}"

# ── Validate ──────────────────────────────────────────────────────────────────
if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "ERROR: No git repo found at $REPO_DIR" >&2
  exit 1
fi

# ── Remove worktree ───────────────────────────────────────────────────────────
if [[ -d "$WORKTREE_DIR" ]]; then
  echo "▶ Removing worktree at $WORKTREE_DIR..."
  cd "$REPO_DIR"
  git worktree remove --force "$WORKTREE_DIR"
  git worktree prune --quiet
  echo "✅ Worktree removed: $WORKTREE_DIR"
else
  echo "⚠️  Worktree not found at $WORKTREE_DIR — nothing to clean up"
  # Still run prune to tidy any dangling references
  cd "$REPO_DIR"
  git worktree prune --quiet 2>/dev/null || true
fi

echo "✅ Cleanup complete. Your working directory is unchanged."
