import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { validWorktreePaths } from './worktreeRegistry';

function validateWorktreePath(worktreePath: string): string | undefined {
  if (!validWorktreePaths.has(path.resolve(worktreePath))) {
    return 'Invalid worktree path: not a known managed worktree';
  }
  return undefined;
}

interface ReadFileInput {
  worktreePath: string;
  filePath: string;
}

function validatePath(worktreePath: string, filePath: string): string | undefined {
  const wtError = validateWorktreePath(worktreePath);
  if (wtError) return wtError;

  const normalized = path.normalize(filePath);
  if (normalized === '..' || normalized.startsWith('..' + path.sep) || path.isAbsolute(normalized)) {
    return 'Path traversal not allowed: filePath must be relative and within the worktree';
  }
  const resolved = path.resolve(worktreePath, normalized);
  const root = path.resolve(worktreePath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return 'Path traversal not allowed: resolved path escapes the worktree';
  }
  return undefined;
}

export function registerReadFileTool(): vscode.Disposable {
  return vscode.lm.registerTool('workcenter-readFile', {
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<ReadFileInput>,
      _token: vscode.CancellationToken,
    ) {
      const { worktreePath, filePath } = options.input;

      const error = validatePath(worktreePath, filePath);
      if (error) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(error),
        ]);
      }

      try {
        const fullPath = path.join(worktreePath, filePath);

        // Resolve symlinks in all path segments and verify the real path
        // stays within the worktree root
        const realPath = await fs.realpath(fullPath);
        const realRoot = await fs.realpath(worktreePath);
        if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('Path escapes the worktree after resolving symlinks'),
          ]);
        }

        const uri = vscode.Uri.file(realPath);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = new TextDecoder('utf-8').decode(bytes);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(content),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error reading file: ${msg}`),
        ]);
      }
    },
  });
}

export { validatePath };
