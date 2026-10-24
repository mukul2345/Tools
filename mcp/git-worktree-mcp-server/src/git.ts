import path from 'node:path';
import { promises as fs } from 'node:fs';
import { gitIn, git } from './exec.js';

export interface RepoStatus {
  path: string;
  name: string;
  isRepo: boolean;
  currentBranch: string | null;
  defaultBranch: string | null;
  dirty: boolean;
  dirtyFiles: number;
  worktrees: WorktreeInfo[];
  error?: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  bare: boolean;
  detached: boolean;
}

/** Resolve the repo name from its path. */
export function repoName(repoPath: string): string {
  return path.basename(path.resolve(repoPath));
}

/** Current checked-out branch (null when detached). */
export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  const res = await gitIn(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!res.ok) return null;
  const branch = res.stdout.trim();
  return branch === 'HEAD' ? null : branch;
}

/**
 * Determine the repo's default branch.
 * Tries origin/HEAD first, then falls back to whichever of master/main exists,
 * preferring master (per the team convention here).
 */
export async function getDefaultBranch(repoPath: string): Promise<string | null> {
  const headRes = await gitIn(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (headRes.ok && headRes.stdout.trim()) {
    // e.g. refs/remotes/origin/master -> master
    const parts = headRes.stdout.trim().split('/');
    const name = parts[parts.length - 1];
    if (name) return name;
  }

  return getMasterBranch(repoPath);
}

/**
 * Resolve the "master-like" branch, preferring `master` then `main`.
 * Unlike getDefaultBranch this ignores origin/HEAD (which in some repos here
 * points at develop) — sync_master should always target the real master.
 * Returns null if neither master nor main exists locally or on origin.
 */
export async function getMasterBranch(repoPath: string): Promise<string | null> {
  for (const candidate of ['master', 'main']) {
    const local = await gitIn(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (local.ok) return candidate;
    const remote = await gitIn(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`]);
    if (remote.ok) return candidate;
  }
  return null;
}

/** Count of changed/untracked files in the working tree. */
export async function getDirty(repoPath: string): Promise<{ dirty: boolean; count: number }> {
  const res = await gitIn(repoPath, ['status', '--porcelain']);
  if (!res.ok) return { dirty: false, count: 0 };
  const lines = res.stdout.split('\n').filter((l) => l.trim().length > 0);
  return { dirty: lines.length > 0, count: lines.length };
}

/** Parse `git worktree list --porcelain` into structured entries. */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const res = await gitIn(repoPath, ['worktree', 'list', '--porcelain']);
  if (!res.ok) return [];
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> | null = null;

  for (const raw of res.stdout.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(finalizeWorktree(current));
      current = { path: line.slice('worktree '.length), bare: false, detached: false, branch: null, head: null };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    }
  }
  if (current) worktrees.push(finalizeWorktree(current));
  return worktrees;
}

function finalizeWorktree(p: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: p.path ?? '',
    branch: p.branch ?? null,
    head: p.head ?? null,
    bare: p.bare ?? false,
    detached: p.detached ?? false,
  };
}

/** Full status snapshot for one repo. */
export async function getRepoStatus(repoPath: string): Promise<RepoStatus> {
  const name = repoName(repoPath);
  const base: RepoStatus = {
    path: repoPath,
    name,
    isRepo: true,
    currentBranch: null,
    defaultBranch: null,
    dirty: false,
    dirtyFiles: 0,
    worktrees: [],
  };

  const topLevel = await gitIn(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!topLevel.ok || topLevel.stdout.trim() !== 'true') {
    return { ...base, isRepo: false, error: 'Not a git work tree' };
  }

  const [current, def, dirty, worktrees] = await Promise.all([
    getCurrentBranch(repoPath),
    getDefaultBranch(repoPath),
    getDirty(repoPath),
    listWorktrees(repoPath),
  ]);

  base.currentBranch = current;
  base.defaultBranch = def;
  base.dirty = dirty.dirty;
  base.dirtyFiles = dirty.count;
  base.worktrees = worktrees;
  return base;
}

/** Where the separated worktree for a repo+branch lives, centrally. */
export function worktreePathFor(worktreeRoot: string, repoPath: string, branch: string): string {
  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  return path.join(path.resolve(worktreeRoot), `${repoName(repoPath)}-${safeBranch}`);
}

export interface SyncResult {
  repo: string;
  path: string;
  branch: string;
  status: 'pulled' | 'up-to-date' | 'skipped' | 'failed';
  worktreePath?: string;
  worktreeCreated?: boolean;
  reason?: string;
  detail?: string;
}

/**
 * Ensure a worktree exists for `branch` at the central location, then
 * (for master) checkout + fast-forward pull inside that worktree.
 *
 * The repo's main working directory is never touched — its branch and
 * working tree are left exactly as they were.
 */
export async function syncBranchWorktree(
  repoPath: string,
  branch: string,
  worktreeRoot: string,
  opts: { dryRun?: boolean; pull?: boolean } = {}
): Promise<SyncResult> {
  const name = repoName(repoPath);
  const wtPath = worktreePathFor(worktreeRoot, repoPath, branch);
  const result: SyncResult = { repo: name, path: repoPath, branch, status: 'skipped', worktreePath: wtPath };

  const norm = (p: string) => path.resolve(p);
  const worktrees = await listWorktrees(repoPath);
  // A worktree already living at our central target path — reuse it.
  const existingCentral = worktrees.find((w) => norm(w.path) === norm(wtPath));
  // The branch checked out somewhere else (e.g. the repo's MAIN working dir).
  // git normally refuses to check the same branch out twice, so creating a
  // dedicated worktree in that case needs --force. The forced worktree is a
  // fresh checkout from the commit and does not touch the other checkout.
  const branchElsewhere = worktrees.find((w) => w.branch === branch && norm(w.path) !== norm(wtPath));

  if (opts.dryRun) {
    result.status = 'skipped';
    result.reason = existingCentral
      ? `dry-run: would pull ${branch} in existing central worktree ${existingCentral.path}`
      : branchElsewhere
        ? `dry-run: would create a dedicated (--force) worktree at ${wtPath} and pull ${branch} (branch also checked out at ${branchElsewhere.path})`
        : `dry-run: would create worktree at ${wtPath} and pull ${branch}`;
    return result;
  }

  let worktreeCreated = false;
  let activeWtPath = existingCentral?.path ?? wtPath;

  if (!existingCentral) {
    // Make sure we have the remote branch before creating the worktree.
    await gitIn(repoPath, ['fetch', 'origin', branch]);

    await fs.mkdir(path.dirname(wtPath), { recursive: true });

    const hasLocal = (await gitIn(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
    const addArgs = ['worktree', 'add'];
    // Force only when the branch is already checked out elsewhere.
    if (branchElsewhere) addArgs.push('--force');
    if (hasLocal) {
      addArgs.push(wtPath, branch);
    } else {
      addArgs.push('--track', '-b', branch, wtPath, `origin/${branch}`);
    }

    const add = await gitIn(repoPath, addArgs);
    if (!add.ok) {
      result.status = 'failed';
      result.reason = 'worktree add failed';
      result.detail = (add.stderr || add.stdout).trim();
      return result;
    }
    worktreeCreated = true;
    activeWtPath = wtPath;
  }
  result.worktreeCreated = worktreeCreated;
  result.worktreePath = activeWtPath;

  if (opts.pull === false) {
    result.status = worktreeCreated ? 'pulled' : 'up-to-date';
    result.reason = 'worktree ensured; pull skipped';
    return result;
  }

  // Switch to the branch inside the worktree (it should already be on it) and
  // fast-forward pull. --ff-only guarantees we never auto-merge a divergence.
  const checkout = await gitIn(activeWtPath, ['checkout', branch]);
  if (!checkout.ok) {
    result.status = 'failed';
    result.reason = 'checkout in worktree failed';
    result.detail = (checkout.stderr || checkout.stdout).trim();
    return result;
  }

  const pull = await gitIn(activeWtPath, ['pull', '--ff-only', 'origin', branch]);
  if (!pull.ok) {
    result.status = 'failed';
    result.reason = 'ff-only pull failed (branch may have diverged)';
    result.detail = (pull.stderr || pull.stdout).trim();
    return result;
  }

  const out = pull.stdout + pull.stderr;
  result.status = /Already up to date|Already up-to-date/i.test(out) && !worktreeCreated ? 'up-to-date' : 'pulled';
  result.detail = out.trim().split('\n').slice(-3).join(' | ');
  return result;
}

export interface RemoveResult {
  path: string;
  status: 'removed' | 'skipped' | 'failed';
  reason?: string;
  detail?: string;
}

/** Remove a worktree. Refuses a dirty worktree unless force is set. */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = false
): Promise<RemoveResult> {
  const args = ['worktree', 'remove', worktreePath];
  if (force) args.push('--force');
  const res = await gitIn(repoPath, args);
  if (!res.ok) {
    const detail = (res.stderr || res.stdout).trim();
    if (!force && /contains modified or untracked files|is dirty/i.test(detail)) {
      return { path: worktreePath, status: 'skipped', reason: 'worktree has uncommitted changes (use force to override)', detail };
    }
    return { path: worktreePath, status: 'failed', reason: 'worktree remove failed', detail };
  }
  // Tidy administrative refs to keep `git worktree list` clean.
  await gitIn(repoPath, ['worktree', 'prune']);
  return { path: worktreePath, status: 'removed' };
}
