import { execFile } from 'child_process';

/** Run a git command in the given directory. Returns stdout. */
export function gitExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', ...args],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const errorOutput = stderr?.trim() || 'git command failed';
          reject(new Error(`git ${args[0]} failed: ${errorOutput}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}
