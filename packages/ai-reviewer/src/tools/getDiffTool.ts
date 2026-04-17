import * as vscode from 'vscode';
import * as path from 'path';
import { gitExec } from './gitUtils';
import { validWorktreePaths } from './worktreeRegistry';

/** Maximum characters of diff output before truncation.
 *  Large PRs can produce multi-MB diffs that overflow the model's context window,
 *  causing tool_use/tool_result mismatch errors on the next iteration. */
export const MAX_DIFF_LENGTH = 100_000;

interface GetDiffInput {
  worktreePath: string;
  baseRef: string;
  headRef: string;
}

export function registerGetDiffTool(): vscode.Disposable {
  return vscode.lm.registerTool('devdocket-getDiff', {
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

      if (/^-|\s/.test(baseRef) || /^-|\s/.test(headRef)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Invalid ref: refs must not start with - or contain whitespace'),
        ]);
      }

      try {
        const output = await gitExec(
          ['diff', '--no-color', `${baseRef}...${headRef}`],
          worktreePath,
        );

        if (!output) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('(no diff)'),
          ]);
        }

        if (output.length <= MAX_DIFF_LENGTH) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(output),
          ]);
        }

        // Diff exceeds the limit — get a stat summary so the model still
        // knows every changed file, then include a truncated portion of
        // the actual diff for initial context.
        let stat = '';
        try {
          stat = await gitExec(
            ['diff', '--stat', '--no-color', `${baseRef}...${headRef}`],
            worktreePath,
          );
        } catch {
          // best-effort — proceed without stat
        }

        const truncatedDiff = output.slice(0, MAX_DIFF_LENGTH);
        const parts = [
          stat ? `## Diff stat summary\n\n${stat}\n\n` : '',
          `## Diff (truncated — ${output.length.toLocaleString()} chars total, showing first ${MAX_DIFF_LENGTH.toLocaleString()})\n\n`,
          truncatedDiff,
          '\n\n(truncated — use devdocket-getFileDiff to read individual file diffs)',
        ];

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(parts.join('')),
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
