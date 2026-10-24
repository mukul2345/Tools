import { execFile } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run `git` with the given args. Args are always passed as an array to
 * execFile (never string-interpolated into a shell), so caller-provided
 * values like paths and branch names cannot inject shell commands.
 *
 * `cwd` is used purely as the working directory; repo targeting is done with
 * explicit `-C <path>` args by callers so we never rely on process.cwd().
 */
export function git(args: string[], cwd?: string, timeoutMs = 120_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        // Prevent git from ever blocking on an interactive credential/host prompt.
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: process.env.GIT_ASKPASS ?? 'echo',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((error as unknown as { code: number }).code)
            : null;
          resolve({ ok: false, code, stdout: stdout ?? '', stderr: (stderr || error.message) ?? '' });
          return;
        }
        resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
  });
}

/** Convenience wrapper that targets a specific repo via `-C`. */
export function gitIn(repoPath: string, args: string[], timeoutMs?: number): Promise<GitResult> {
  return git(['-C', repoPath, ...args], undefined, timeoutMs);
}
