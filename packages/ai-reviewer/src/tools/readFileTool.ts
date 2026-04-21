import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { validatePath } from './pathValidator';
import { errorToString } from './errorUtils';

interface ReadFileInput {
  worktreePath: string;
  filePath: string;
}

export function registerReadFileTool(): vscode.Disposable {
  return vscode.lm.registerTool('devdocket-readFile', {
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
        const msg = errorToString(err);
        const isNotFound =
          msg.includes('ENOENT') ||
          msg.includes('FileNotFound') ||
          msg.includes('no such file');
        if (isNotFound) {
          let siblings = '';
          try {
            const parentRel = path.dirname(filePath);
            const parentFull = path.join(worktreePath, parentRel);
            // Resolve symlinks and ensure parent stays within the worktree
            const realParent = await fs.realpath(parentFull);
            const realRoot = await fs.realpath(worktreePath);
            if (realParent.startsWith(realRoot + path.sep) || realParent === realRoot) {
              const parentUri = vscode.Uri.file(realParent);
              const entries = await vscode.workspace.fs.readDirectory(parentUri);
              if (entries.length > 0) {
                const allNames = entries.map(([name]: [string, unknown]) => path.posix.join(parentRel.replace(/\\/g, '/'), name));
                const displayNames = allNames.length > 30
                  ? [...allNames.slice(0, 30), `... and ${allNames.length - 30} more files`]
                  : allNames;
                siblings = `\nFiles in '${parentRel}':\n${displayNames.join('\n')}\nUse one of these exact paths.`;
              }
            }
          } catch {
            // parent dir doesn't exist, can't be resolved safely, or is outside the worktree — skip listing
          }
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Error: file not found at '${filePath}'.${siblings}`),
          ]);
        }
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error reading file: ${msg}`),
        ]);
      }
    },
  });
}
