import * as vscode from 'vscode';
import * as path from 'path';
import { gitExec } from './gitUtils';
import { validWorktreePaths } from './worktreeRegistry';

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

      if (!validWorktreePaths.has(path.resolve(worktreePath))) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Invalid worktree path: not a known managed worktree'),
        ]);
      }

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
