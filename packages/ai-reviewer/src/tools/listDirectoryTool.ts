import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { validateWorktreePath, validateRelativePath } from './pathValidator';
import { errorToString } from './errorUtils';

interface ListDirectoryInput {
  worktreePath: string;
  dirPath?: string;
}

export function registerListDirectoryTool(): vscode.Disposable {
  return vscode.lm.registerTool('devdocket-listDirectory', {
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<ListDirectoryInput>,
      _token: vscode.CancellationToken,
    ) {
      const { worktreePath, dirPath } = options.input;

      const wtError = validateWorktreePath(worktreePath);
      if (wtError) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(wtError),
        ]);
      }

      const relDir = dirPath ?? '.';
      const pathError = validateRelativePath(worktreePath, relDir, 'dirPath');
      if (pathError) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(pathError),
        ]);
      }

      const resolved = path.resolve(worktreePath, path.normalize(relDir));

      try {
        // Resolve symlinks in all path segments and verify containment
        const realPath = await fs.realpath(resolved);
        const realRoot = await fs.realpath(worktreePath);
        if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('Path escapes the worktree after resolving symlinks'),
          ]);
        }

        const uri = vscode.Uri.file(realPath);
        const entries = await vscode.workspace.fs.readDirectory(uri);
        const lines = entries.map(([name, type]) => {
          const isSymbolicLink = (type & vscode.FileType.SymbolicLink) !== 0;
          const isDirectory = (type & vscode.FileType.Directory) !== 0;
          const kind = isSymbolicLink ? '[link]' : isDirectory ? '[dir]' : '[file]';
          return `${kind}  ${name}`;
        });
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(lines.join('\n') || '(empty directory)'),
        ]);
      } catch (err) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error listing directory: ${errorToString(err)}`),
        ]);
      }
    },
  });
}
