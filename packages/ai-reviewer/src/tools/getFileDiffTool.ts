import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { gitExec } from './gitUtils';
import { validWorktreePaths } from './worktreeRegistry';

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

      // Path traversal protection
      const normalized = path.normalize(filePath);
      if (normalized.startsWith('..' + path.sep) || normalized === '..' || path.isAbsolute(normalized)) {
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
        if (!output) {
          const fullPath = path.join(worktreePath, normalized);
          if (!fs.existsSync(fullPath)) {
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
            const suggestion = fileList
              ? `\nThe changed files in this PR are:\n${fileList}\nUse these exact paths when calling tools.`
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
        const msg = err instanceof Error ? err.message : String(err);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error getting file diff: ${msg}`),
        ]);
      }
    },
  });
}
