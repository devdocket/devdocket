import * as vscode from 'vscode';
import * as path from 'path';
import { validWorktreePaths } from './worktreeRegistry';

interface ListDirectoryInput {
  worktreePath: string;
  dirPath?: string;
}

export function registerListDirectoryTool(): vscode.Disposable {
  return vscode.lm.registerTool('workcenter-listDirectory', {
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<ListDirectoryInput>,
      _token: vscode.CancellationToken,
    ) {
      const { worktreePath, dirPath } = options.input;

      if (!validWorktreePaths.has(path.resolve(worktreePath))) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Invalid worktree path: not a known managed worktree'),
        ]);
      }

      const relDir = dirPath ?? '.';
      const normalized = path.normalize(relDir);
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'Path traversal not allowed: dirPath must be relative and within the worktree',
          ),
        ]);
      }

      const resolved = path.resolve(worktreePath, normalized);
      if (!resolved.startsWith(path.resolve(worktreePath))) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            'Path traversal not allowed: resolved path escapes the worktree',
          ),
        ]);
      }

      try {
        const uri = vscode.Uri.file(resolved);
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
        const msg = err instanceof Error ? err.message : String(err);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error listing directory: ${msg}`),
        ]);
      }
    },
  });
}
