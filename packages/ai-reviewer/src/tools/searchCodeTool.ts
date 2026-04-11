import * as vscode from 'vscode';
import * as path from 'path';
import { gitExec } from './gitUtils';
import { validWorktreePaths } from './worktreeRegistry';

interface SearchCodeInput {
  worktreePath: string;
  pattern: string;
  fileGlob?: string;
  maxResults?: number;
}

export function registerSearchCodeTool(): vscode.Disposable {
  return vscode.lm.registerTool('workcenter-searchCode', {
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<SearchCodeInput>,
      _token: vscode.CancellationToken,
    ) {
      const { worktreePath, pattern, fileGlob, maxResults } = options.input;
      const limit = maxResults ?? 50;

      if (!validWorktreePaths.has(path.resolve(worktreePath))) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Invalid worktree path: not a known managed worktree'),
        ]);
      }

      try {
        const args = ['grep', '-n', '--no-color', '--', pattern];
        if (fileGlob) {
          args.push(fileGlob);
        }
        const output = await gitExec(args, worktreePath);

        const lines = output.split('\n');
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
        // git grep exits with code 1 when no matches are found
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('exit code 1') || msg.includes('git grep failed')) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('(no matches found)'),
          ]);
        }
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error searching code: ${msg}`),
        ]);
      }
    },
  });
}
