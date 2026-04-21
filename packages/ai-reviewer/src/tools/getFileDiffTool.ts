import * as vscode from 'vscode';
import { gitExec } from './gitUtils';
import { validateWorktreePath, validateRelativePath } from './pathValidator';
import { errorToString } from './errorUtils';
import { isValidRef } from './refValidation';

interface GetFileDiffInput {
  worktreePath: string;
  baseRef: string;
  headRef: string;
  filePath: string;
}

export function registerGetFileDiffTool(): vscode.Disposable {
  return vscode.lm.registerTool('devdocket-getFileDiff', {
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<GetFileDiffInput>,
      _token: vscode.CancellationToken,
    ) {
      const { worktreePath, baseRef, headRef, filePath } = options.input;

      const wtError = validateWorktreePath(worktreePath);
      if (wtError) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(wtError),
        ]);
      }

      if (!isValidRef(baseRef) || !isValidRef(headRef)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Invalid ref: refs must be non-empty, must not start with "-", and may contain only alphanumeric, dot, underscore, hyphen, or slash characters'),
        ]);
      }

      // Path traversal protection
      const pathError = validateRelativePath(worktreePath, filePath);
      if (pathError) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(pathError),
        ]);
      }

      try {
        const output = await gitExec(
          ['diff', '--no-color', `${baseRef}...${headRef}`, '--', filePath],
          worktreePath,
        );
        if (!output) {
          // Use git to check if the file is tracked, avoiding filesystem
          // operations that could follow symlinks outside the worktree.
          let fileKnown = false;
          try {
            const lsOutput = await gitExec(['ls-files', '--', filePath], worktreePath);
            fileKnown = lsOutput.trim().length > 0;
          } catch {
            // ignore — best-effort check
          }
          if (!fileKnown) {
            let changedFiles = '';
            try {
              changedFiles = await gitExec(
                ['diff', '--name-only', `${baseRef}...${headRef}`],
                worktreePath,
              );
            } catch {
              // ignore — best-effort listing
            }
            const fileList = changedFiles.trim();
            let displayList = fileList;
            if (fileList) {
              const lines = fileList.split('\n');
              if (lines.length > 30) {
                displayList = [...lines.slice(0, 30), `... and ${lines.length - 30} more files`].join('\n');
              }
            }
            const suggestion = displayList
              ? `\nThe changed files in this PR are:\n${displayList}\nUse these exact paths when calling tools.`
              : '\nVerify the path matches the diff output exactly (paths shown after a/ and b/ in diff headers).';
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                `Error: file not found at '${filePath}'.${suggestion}`,
              ),
            ]);
          }
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('(no diff for this file)'),
          ]);
        }
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(output),
        ]);
      } catch (err) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error getting file diff: ${errorToString(err)}`),
        ]);
      }
    },
  });
}
