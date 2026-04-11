import * as vscode from 'vscode';
import { execFile } from 'child_process';

interface GetDiffInput {
  worktreePath: string;
  baseRef: string;
  headRef: string;
}

export function registerGetDiffTool(): vscode.Disposable {
  return vscode.lm.registerTool('workcenter-getDiff', {
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<GetDiffInput>,
      _token: vscode.CancellationToken,
    ) {
      const { worktreePath, baseRef, headRef } = options.input;

      try {
        const output = await gitExec(
          ['diff', '--no-color', `${baseRef}...${headRef}`],
          worktreePath,
        );
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(output || '(no diff)'),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error getting diff: ${msg}`),
        ]);
      }
    },
  });
}

function gitExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', ...args],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}
