import * as vscode from 'vscode';
import * as path from 'path';
import { gitExec } from './gitUtils';
import { validWorktreePaths } from './worktreeRegistry';
import { isValidRef } from './refValidation';

/** Maximum characters of diff output before truncation.
 *  Keep below the walkthrough tool-result limit (MAX_TOOL_RESULT_LENGTH)
 *  so this tool's own truncation footer and stat framing survive
 *  end-to-end without being re-truncated downstream.
 *  Large PRs can produce multi-MB diffs that overflow the model's context
 *  window, causing tool_use/tool_result mismatch errors on the next
 *  iteration. */
export const MAX_DIFF_LENGTH = 75_000;

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

      if (!isValidRef(baseRef) || !isValidRef(headRef)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Invalid ref: refs must be non-empty, must not start with "-", and may contain only alphanumeric, dot, underscore, hyphen, or slash characters'),
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

        const footer = '\n\n(truncated — use devdocket-getFileDiff to read individual file diffs)';
        // Ensure at least half the budget goes to actual diff content.
        // If the stat is too large, truncate it to fit the available space.
        const minDiffBudget = Math.floor(MAX_DIFF_LENGTH / 2);
        const statPrefix = '## Diff stat summary\n\n';
        const statSuffix = '\n\n';
        const maxStatLength = MAX_DIFF_LENGTH - minDiffBudget - footer.length - 200 - statPrefix.length - statSuffix.length;
        let framing = '';
        if (stat && maxStatLength > 0) {
          const trimmedStat = stat.length <= maxStatLength
            ? stat
            : stat.slice(0, maxStatLength) + '\n(stat truncated)';
          framing = `${statPrefix}${trimmedStat}${statSuffix}`;
        }
        const diffBudget = Math.max(0, MAX_DIFF_LENGTH - framing.length - footer.length - 200);
        const truncatedDiff = output.slice(0, diffBudget);
        const parts = [
          framing,
          `## Diff (truncated — ${output.length.toLocaleString()} chars total, showing first ${diffBudget.toLocaleString()})\n\n`,
          truncatedDiff,
          footer,
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
