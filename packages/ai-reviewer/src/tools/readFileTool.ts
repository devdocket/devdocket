import * as vscode from 'vscode';
import * as path from 'path';

interface ReadFileInput {
  worktreePath: string;
  filePath: string;
}

function validatePath(worktreePath: string, filePath: string): string | undefined {
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return 'Path traversal not allowed: filePath must be relative and within the worktree';
  }
  const resolved = path.resolve(worktreePath, normalized);
  if (!resolved.startsWith(path.resolve(worktreePath))) {
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
        const uri = vscode.Uri.file(fullPath);
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
