import * as vscode from 'vscode';
import { gitExec } from './gitUtils';
import { validateWorktreePath, validateRelativePath } from './pathValidator';
import { errorToString } from './errorUtils';

interface GitLogInput {
  worktreePath: string;
  filePath?: string;
  maxCount?: number;
}

export function registerGitLogTool(): vscode.Disposable {
  return vscode.lm.registerTool('devdocket-gitLog', {
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<GitLogInput>,
      _token: vscode.CancellationToken,
    ) {
      const { worktreePath, filePath, maxCount } = options.input;
      const limit = Math.min(Math.max(1, maxCount ?? 20), 200);

      const wtError = validateWorktreePath(worktreePath);
      if (wtError) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(wtError),
        ]);
      }

      // Path traversal protection for optional filePath
      if (filePath) {
        const pathError = validateRelativePath(worktreePath, filePath);
        if (pathError) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(pathError),
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
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error running git log: ${errorToString(err)}`),
        ]);
      }
    },
  });
}
