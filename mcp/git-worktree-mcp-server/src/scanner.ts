import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Directory names we never descend into while searching for repos. */
const DEFAULT_IGNORES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.pnpm-store',
  '.cache',
  '.worktrees',
]);

export interface DiscoverOptions {
  /** Extra directory names to skip (added to the defaults). */
  excludeDirs?: string[];
  /** Maximum depth to descend from the root. Default 6. */
  maxDepth?: number;
  /** Follow a repo's children too (default false — a repo is a leaf). */
  descendIntoRepos?: boolean;
}

async function isGitRepo(dir: string): Promise<boolean> {
  // A normal repo has a `.git` directory; a worktree/submodule has a `.git` file.
  try {
    const gitPath = path.join(dir, '.git');
    const stat = await fs.stat(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Recursively find every git repository under `root`.
 *
 * Handles the common case where a parent folder is NOT itself a repo but its
 * children are (e.g. a `VTP/` folder holding many service repos). By default a
 * repo is treated as a leaf — we do not descend into a repo's subfolders,
 * which avoids picking up vendored/nested repos and keeps the scan fast.
 */
export async function discoverRepos(root: string, opts: DiscoverOptions = {}): Promise<string[]> {
  const ignores = new Set(DEFAULT_IGNORES);
  for (const d of opts.excludeDirs ?? []) ignores.add(d);
  const maxDepth = opts.maxDepth ?? 6;
  const descendIntoRepos = opts.descendIntoRepos ?? false;

  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    if (await isGitRepo(dir)) {
      found.push(dir);
      if (!descendIntoRepos) return;
    }

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }

    const subdirs = entries.filter((e) => {
      if (!e.isDirectory() && !e.isSymbolicLink()) return false;
      if (e.name.startsWith('.') && e.name !== '.git') {
        // skip hidden dirs except we already handled .git detection above
        return false;
      }
      return !ignores.has(e.name);
    });

    // Process in parallel but bounded by directory fan-out (fine for a dev tree).
    await Promise.all(
      subdirs.map((e) => walk(path.join(dir, e.name), depth + 1))
    );
  }

  await walk(path.resolve(root), 0);
  found.sort();
  return found;
}
