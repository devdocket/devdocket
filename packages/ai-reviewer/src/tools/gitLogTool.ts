import * as vscode from 'vscode';
import * as path from 'path';
import { gitExec } from './gitUtils';
import { validWorktreePaths } from './worktreeRegistry';

interface GitLogInput {
  worktreePath: string;
  filePath?: string;
  maxCount?: number;
}

export function registerGitLogTool(): vscode.Disposable {
  return vscode.lm.registerTool('workcenter-gitLog', {
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<GitLogInput>,
      _token: vscode.CancellationToken,
    ) {
      const { worktreePath, filePath, maxCount } = options.input;
      const limit = Math.min(Math.max(1, maxCount ?? 20), 200);

      if (!validWorktreePaths.has(path.resolve(worktreePath))) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Invalid worktree path: not a known managed worktree'),
        ]);
      }

      // Path traversal protection for optional filePath
      if (filePath) {
        const normalized = path.normalize(filePath);
        if (normalized.startsWith('..' + path.sep) || normalized === '..' || path.isAbsolute(normalized)) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              'Path traversal not allowed: filePath must be relative and within the worktree',
            ),
          ]);
        }
      }

      try {
        const args = ['log', '--oneline', '-n', String(limit)];
        if (filePath) {
          args.push('--', filePath);
        }
        const output = await gitExec(args, worktreePath);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(output || '(no commits found)'),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error running git log: ${msg}`),
        ]);
      }
    },
  });
}
