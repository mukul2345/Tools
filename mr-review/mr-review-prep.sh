#!/usr/bin/env bash
# =============================================================================
# mr-review-prep.sh
# Prepares a git worktree for MR review — always uses worktree so the
# reviewer's current branch is never touched.
#
# Usage:
#   ./mr-review-prep.sh <repo-name> <source-branch>
#
# Example:
#   ./mr-review-prep.sh apollo-service feat/DMW-1234-add-validation
#
# Output (sourced by the agent):
#   WORKTREE_PATH=<absolute-path>   — the dir to run the review from
#   WORKTREE_BRANCH=<branch>        — the branch that was checked out
#   WORKTREE_CREATED=true|false     — whether a new worktree was created
# =============================================================================

set -euo pipefail

PROJECTS_ROOT="/Users/ravitejag/my-projects"
REPO_NAME="${1:?Usage: mr-review-prep.sh <repo-name> <source-branch>}"
SOURCE_BRANCH="${2:?Usage: mr-review-prep.sh <repo-name> <source-branch>}"

REPO_DIR="$PROJECTS_ROOT/$REPO_NAME"
# Sanitise branch name for use as a directory name (replace / with -)
SAFE_BRANCH="${SOURCE_BRANCH//\//-}"
WORKTREE_DIR="$PROJECTS_ROOT/mr-review-${REPO_NAME}-${SAFE_BRANCH}"

# ── Validate repo exists ──────────────────────────────────────────────────────
if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "ERROR: No git repo found at $REPO_DIR" >&2
  echo "       Make sure the repo is cloned at $PROJECTS_ROOT/$REPO_NAME" >&2
  exit 1
fi

cd "$REPO_DIR"

# ── Fetch latest from remote ──────────────────────────────────────────────────
echo "▶ Fetching latest from remote..."
git fetch --quiet origin "$SOURCE_BRANCH" 2>/dev/null || {
  echo "WARNING: Could not fetch branch '$SOURCE_BRANCH' from remote — using local state" >&2
}

# ── Check if branch exists locally or remotely ───────────────────────────────
LOCAL_EXISTS=$(git rev-parse --verify "refs/heads/$SOURCE_BRANCH" 2>/dev/null && echo "true" || echo "false")
REMOTE_EXISTS=$(git rev-parse --verify "refs/remotes/origin/$SOURCE_BRANCH" 2>/dev/null && echo "true" || echo "false")

if [[ "$LOCAL_EXISTS" == "false" && "$REMOTE_EXISTS" == "false" ]]; then
  echo "ERROR: Branch '$SOURCE_BRANCH' not found locally or on remote origin." >&2
  exit 1
fi

# ── Remove stale worktree if it already exists ────────────────────────────────
if [[ -d "$WORKTREE_DIR" ]]; then
  echo "▶ Removing stale worktree at $WORKTREE_DIR..."
  git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
  git worktree prune --quiet
fi

# ── Create fresh worktree ─────────────────────────────────────────────────────
echo "▶ Creating worktree at $WORKTREE_DIR..."
if [[ "$REMOTE_EXISTS" == "true" ]]; then
  git worktree add "$WORKTREE_DIR" "origin/$SOURCE_BRANCH" --detach --quiet
  # Reset to the remote tracking branch so files are correct
  cd "$WORKTREE_DIR"
  git checkout -B "$SOURCE_BRANCH" "origin/$SOURCE_BRANCH" --quiet 2>/dev/null || true
else
  git worktree add "$WORKTREE_DIR" "$SOURCE_BRANCH" --quiet
fi

cd "$WORKTREE_DIR"

# ── Install dependencies ──────────────────────────────────────────────────────
if [[ -f "package.json" ]]; then
  echo "▶ Running pnpm install..."
  pnpm install --frozen-lockfile --prefer-offline 2>/dev/null \
    || pnpm install --prefer-offline 2>/dev/null \
    || pnpm install
  echo "✅ Dependencies installed"
else
  echo "⚠️  No package.json found — skipping pnpm install"
fi

# ── Emit structured output for the agent ─────────────────────────────────────
echo ""
echo "WORKTREE_PATH=$WORKTREE_DIR"
echo "WORKTREE_BRANCH=$SOURCE_BRANCH"
echo "WORKTREE_CREATED=true"
echo "REPO_DIR=$REPO_DIR"
echo ""
echo "✅ Worktree ready at: $WORKTREE_DIR"
