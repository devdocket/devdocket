import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';

interface GetFileDiffInput {
  worktreePath: string;
  baseRef: string;
  headRef: string;
  filePath: string;
}

export function registerGetFileDiffTool(): vscode.Disposable {
  return vscode.lm.registerTool('workcenter-getFileDiff', {
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<GetFileDiffInput>,
      _token: vscode.CancellationToken,
    ) {
      const { worktreePath, baseRef, headRef, filePath } = options.input;

      // Path traversal protection
      const normalized = path.normalize(filePath);
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'Path traversal not allowed: filePath must be relative and within the worktree',
          ),
        ]);
      }

      try {
        const output = await gitExec(
          ['diff', '--no-color', `${baseRef}...${headRef}`, '--', filePath],
          worktreePath,
        );
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(output || '(no diff for this file)'),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error getting file diff: ${msg}`),
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
