import * as path from 'path';
import * as vscode from 'vscode';
import { vi } from 'vitest';

function createMissingFileError(filePath: string): Error & { code: string } {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), { code: 'ENOENT' });
}

export interface MockFileSystem {
  clear(): void;
  readJson<T>(uri: vscode.Uri): T | undefined;
  writeJson(uri: vscode.Uri, value: unknown): void;
  writeRaw(uri: vscode.Uri, value: string): void;
}

export function useMockFileSystem(): MockFileSystem {
  const files = new Map<string, Uint8Array>();

  const normalize = (uri: vscode.Uri): string => path.normalize(uri.fsPath ?? uri.path ?? uri.toString());

  (vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (uri: vscode.Uri) => {
    const key = normalize(uri);
    const content = files.get(key);
    if (!content) {
      throw createMissingFileError(key);
    }
    return content;
  });

  (vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>).mockImplementation(async (uri: vscode.Uri, content: Uint8Array) => {
    files.set(normalize(uri), Uint8Array.from(content));
  });

  (vscode.workspace.fs.createDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (vscode.workspace.fs.rename as ReturnType<typeof vi.fn>).mockImplementation(async (oldUri: vscode.Uri, newUri: vscode.Uri) => {
    const oldKey = normalize(oldUri);
    const content = files.get(oldKey);
    if (!content) {
      throw createMissingFileError(oldKey);
    }
    files.set(normalize(newUri), content);
    files.delete(oldKey);
  });
  (vscode.workspace.fs.delete as ReturnType<typeof vi.fn>).mockImplementation(async (uri: vscode.Uri) => {
    files.delete(normalize(uri));
  });

  return {
    clear(): void {
      files.clear();
    },
    readJson<T>(uri: vscode.Uri): T | undefined {
      const content = files.get(normalize(uri));
      if (!content) {
        return undefined;
      }
      return JSON.parse(Buffer.from(content).toString('utf-8')) as T;
    },
    writeJson(uri: vscode.Uri, value: unknown): void {
      files.set(normalize(uri), Buffer.from(JSON.stringify(value), 'utf-8'));
    },
    writeRaw(uri: vscode.Uri, value: string): void {
      files.set(normalize(uri), Buffer.from(value, 'utf-8'));
    },
  };
}
