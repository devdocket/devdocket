import * as vscode from 'vscode';
import { gitExec, GitExecError } from './gitUtils';
import { validateWorktreePath } from './pathValidator';
import { errorToString } from './errorUtils';

interface SearchCodeInput {
  worktreePath: string;
  pattern: string;
  fileGlob?: string;
  maxResults?: number;
}

export function registerSearchCodeTool(): vscode.Disposable {
  return vscode.lm.registerTool('devdocket-searchCode', {
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<SearchCodeInput>,
      _token: vscode.CancellationToken,
    ) {
      const { worktreePath, pattern, fileGlob, maxResults } = options.input;
      const limit = Math.min(Math.max(1, maxResults ?? 50), 500);

      const wtError = validateWorktreePath(worktreePath);
      if (wtError) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(wtError),
        ]);
      }

      try {
        const args = ['grep', '-n', '--no-color', '-m', String(limit), '-e', pattern];
        if (fileGlob) {
          args.push('--', fileGlob);
        }
        const output = await gitExec(args, worktreePath);

        const trimmed = output.trimEnd();
        const lines = trimmed ? trimmed.split('\n') : [];
        if (lines.length > limit) {
          const truncated = lines.slice(0, limit).join('\n');
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              `${truncated}\n\n(truncated — showing ${limit} of ${lines.length} results)`,
            ),
          ]);
        }

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(output || '(no matches found)'),
        ]);
      } catch (err) {
        // git grep exits with code 1 specifically when no matches are found
        if (err instanceof GitExecError && err.exitCode === 1) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('(no matches found)'),
          ]);
        }
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error searching code: ${errorToString(err)}`),
        ]);
      }
    },
  });
}
