import { execFile } from 'child_process';

/** Error thrown by gitExec, exposing the process exit code. */
export class GitExecError extends Error {
  constructor(message: string, public readonly exitCode: number | null) {
    super(message);
    this.name = 'GitExecError';
  }
}

/** Run a git command in the given directory. Returns stdout. */
export function gitExec(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', ...args],
      {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        env: env ? { ...process.env, ...env } : undefined,
      },
      (err, stdout, stderr) => {
        if (err) {
          const errorOutput = stderr?.trim() || 'git command failed';
          const rawCode = 'code' in err ? (err as { code?: unknown }).code : undefined;
          const exitCode = typeof rawCode === 'number' ? rawCode : null;
          reject(new GitExecError(`git ${args[0]} failed: ${errorOutput}`, exitCode));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}
