#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { discoverRepos } from './scanner.js';
import {
  getRepoStatus,
  getMasterBranch,
  getDirty,
  listWorktrees,
  syncBranchWorktree,
  removeWorktree,
  worktreePathFor,
  repoName,
  type SyncResult,
} from './git.js';

const server = new McpServer({
  name: 'git-worktree-mcp-server',
  version: '1.0.0',
});

/** Root to scan when none is supplied. */
function defaultRoot(): string {
  return process.env.WORKTREE_SCAN_ROOT || process.cwd();
}

/** Central worktree location. Defaults to `<root>/.worktrees` (outside every repo). */
function resolveWorktreeRoot(root: string, worktreeRoot?: string): string {
  if (worktreeRoot) return path.resolve(worktreeRoot);
  if (process.env.WORKTREE_ROOT) return path.resolve(process.env.WORKTREE_ROOT);
  return path.join(path.resolve(root), '.worktrees');
}

function text(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

// ---------------------------------------------------------------------------
// discover_repos — read-only scan / scope review
// ---------------------------------------------------------------------------
server.tool(
  'discover_repos',
  'Recursively find every git repository under a root folder and report each one\'s current branch, default branch (master/main), dirty state, and existing worktrees. Read-only. Parent folders that are not themselves repos but contain repos (e.g. a VTP/ folder) are handled — a repo is treated as a leaf.',
  {
    rootPath: z.string().optional().describe('Root folder to scan. Defaults to WORKTREE_SCAN_ROOT env or the server cwd.'),
    excludeDirs: z.array(z.string()).optional().describe('Extra directory names to skip during the scan.'),
    maxDepth: z.number().optional().describe('Maximum folder depth to descend (default 6).'),
    includeStatus: z.boolean().optional().describe('Include per-repo branch/dirty/worktree status (default true). Set false for a fast path-only listing.'),
  },
  async ({ rootPath, excludeDirs, maxDepth, includeStatus }) => {
    const root = path.resolve(rootPath || defaultRoot());
    const repos = await discoverRepos(root, { excludeDirs, maxDepth });

    if (includeStatus === false) {
      return text({ root, repoCount: repos.length, repos });
    }

    const statuses = await Promise.all(repos.map((r) => getRepoStatus(r).catch((e) => ({
      path: r, name: repoName(r), isRepo: false, currentBranch: null, defaultBranch: null,
      dirty: false, dirtyFiles: 0, worktrees: [], error: String(e),
    }))));

    return text({
      root,
      repoCount: statuses.length,
      dirtyCount: statuses.filter((s) => s.dirty).length,
      noDefaultBranch: statuses.filter((s) => !s.defaultBranch).map((s) => s.name),
      repos: statuses,
    });
  }
);

// ---------------------------------------------------------------------------
// sync_master — ensure central master worktree + pull master in it, for all repos
// ---------------------------------------------------------------------------
server.tool(
  'sync_master',
  'For every repo under the root (or a single repo), ensure a separated master worktree exists at the central worktree location, then checkout master and fast-forward pull inside that worktree. The main working directory is never switched or modified. Dirty repos are skipped and reported by default.',
  {
    rootPath: z.string().optional().describe('Root folder to scan. Defaults to WORKTREE_SCAN_ROOT env or server cwd. Ignored when repoPath is given.'),
    repoPath: z.string().optional().describe('Operate on a single repo instead of scanning a root.'),
    worktreeRoot: z.string().optional().describe('Central folder to hold worktrees. Defaults to <root>/.worktrees.'),
    branch: z.string().optional().describe('Branch to separate + pull. Defaults to each repo\'s detected default branch (master/main).'),
    includeDirty: z.boolean().optional().describe('If true, sync even when the main working tree is dirty (the pull happens in the isolated worktree, so this is safe). Default false = skip dirty repos.'),
    dryRun: z.boolean().optional().describe('Report what would happen without creating worktrees or pulling.'),
  },
  async ({ rootPath, repoPath, worktreeRoot, branch, includeDirty, dryRun }) => {
    const root = path.resolve(rootPath || defaultRoot());
    const wtRoot = resolveWorktreeRoot(root, worktreeRoot);
    const repos = repoPath ? [path.resolve(repoPath)] : await discoverRepos(root);

    const results: SyncResult[] = [];
    for (const repo of repos) {
      const name = repoName(repo);
      const targetBranch = branch || (await getMasterBranch(repo));

      if (!targetBranch) {
        results.push({ repo: name, path: repo, branch: '(unknown)', status: 'skipped', reason: 'could not resolve master/main branch' });
        continue;
      }

      if (!includeDirty) {
        const dirty = await getDirty(repo);
        if (dirty.dirty) {
          results.push({ repo: name, path: repo, branch: targetBranch, status: 'skipped', reason: `working tree dirty (${dirty.count} file(s)); pass includeDirty=true to sync anyway` });
          continue;
        }
      }

      try {
        results.push(await syncBranchWorktree(repo, targetBranch, wtRoot, { dryRun }));
      } catch (e) {
        results.push({ repo: name, path: repo, branch: targetBranch, status: 'failed', reason: 'unexpected error', detail: String(e) });
      }
    }

    const summary = {
      root,
      worktreeRoot: wtRoot,
      dryRun: Boolean(dryRun),
      total: results.length,
      pulled: results.filter((r) => r.status === 'pulled').length,
      upToDate: results.filter((r) => r.status === 'up-to-date').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length,
    };
    return text({ summary, results });
  }
);

// ---------------------------------------------------------------------------
// create_worktree — generic: add a worktree for any branch (develop/release/custom)
// ---------------------------------------------------------------------------
server.tool(
  'create_worktree',
  'Add a worktree for a specific branch (e.g. develop, release, or a custom branch) at the central worktree location, for one repo or all repos under a root. Optionally pull the branch after creating. Use this to spin up a develop/release worktree alongside the separated master.',
  {
    branch: z.string().describe('Branch name to create a worktree for (e.g. "develop", "release", "feature/x").'),
    rootPath: z.string().optional().describe('Root folder to scan (all repos). Defaults to WORKTREE_SCAN_ROOT env or server cwd. Ignored when repoPath is given.'),
    repoPath: z.string().optional().describe('Operate on a single repo instead of scanning a root.'),
    worktreeRoot: z.string().optional().describe('Central folder to hold worktrees. Defaults to <root>/.worktrees.'),
    pull: z.boolean().optional().describe('Fast-forward pull the branch after ensuring the worktree (default true).'),
    dryRun: z.boolean().optional().describe('Report what would happen without making changes.'),
  },
  async ({ branch, rootPath, repoPath, worktreeRoot, pull, dryRun }) => {
    const root = path.resolve(rootPath || defaultRoot());
    const wtRoot = resolveWorktreeRoot(root, worktreeRoot);
    const repos = repoPath ? [path.resolve(repoPath)] : await discoverRepos(root);

    const results: SyncResult[] = [];
    for (const repo of repos) {
      try {
        results.push(await syncBranchWorktree(repo, branch, wtRoot, { dryRun, pull }));
      } catch (e) {
        results.push({ repo: repoName(repo), path: repo, branch, status: 'failed', reason: 'unexpected error', detail: String(e) });
      }
    }

    const summary = {
      root,
      worktreeRoot: wtRoot,
      branch,
      dryRun: Boolean(dryRun),
      total: results.length,
      created: results.filter((r) => r.worktreeCreated).length,
      pulled: results.filter((r) => r.status === 'pulled').length,
      failed: results.filter((r) => r.status === 'failed').length,
    };
    return text({ summary, results });
  }
);

// ---------------------------------------------------------------------------
// list_worktrees — inspect existing worktrees per repo
// ---------------------------------------------------------------------------
server.tool(
  'list_worktrees',
  'List existing git worktrees for a single repo or for every repo under a root.',
  {
    rootPath: z.string().optional().describe('Root folder to scan. Defaults to WORKTREE_SCAN_ROOT env or server cwd. Ignored when repoPath is given.'),
    repoPath: z.string().optional().describe('Operate on a single repo instead of scanning a root.'),
  },
  async ({ rootPath, repoPath }) => {
    const repos = repoPath ? [path.resolve(repoPath)] : await discoverRepos(path.resolve(rootPath || defaultRoot()));
    const out = await Promise.all(
      repos.map(async (repo) => ({ repo: repoName(repo), path: repo, worktrees: await listWorktrees(repo) }))
    );
    return text({ repoCount: out.length, repos: out });
  }
);

// ---------------------------------------------------------------------------
// remove_worktree — clean up a worktree (safe by default)
// ---------------------------------------------------------------------------
server.tool(
  'remove_worktree',
  'Remove a git worktree. Refuses to remove a worktree with uncommitted changes unless force=true. Either pass the exact worktreePath, or pass branch to remove the central worktree for that branch.',
  {
    repoPath: z.string().describe('Path to the repository that owns the worktree.'),
    worktreePath: z.string().optional().describe('Exact path of the worktree to remove.'),
    branch: z.string().optional().describe('Branch whose central worktree should be removed (alternative to worktreePath).'),
    worktreeRoot: z.string().optional().describe('Central worktree folder, used with branch. Defaults to <root>/.worktrees.'),
    rootPath: z.string().optional().describe('Root used to derive the default worktreeRoot when branch is given.'),
    force: z.boolean().optional().describe('Force removal even if the worktree is dirty (default false).'),
  },
  async ({ repoPath, worktreePath, branch, worktreeRoot, rootPath, force }) => {
    const repo = path.resolve(repoPath);
    let target = worktreePath ? path.resolve(worktreePath) : undefined;
    if (!target && branch) {
      const root = path.resolve(rootPath || defaultRoot());
      target = worktreePathFor(resolveWorktreeRoot(root, worktreeRoot), repo, branch);
    }
    if (!target) {
      return text({ status: 'failed', reason: 'provide either worktreePath or branch' });
    }
    return text(await removeWorktree(repo, target, Boolean(force)));
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
