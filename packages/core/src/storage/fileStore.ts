import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../services/logger';

export interface FileStore<T> {
  read(): Promise<T | undefined>;
  write(value: T): Promise<void>;
}

export function isFileMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const code = 'code' in err ? (err as { code?: unknown }).code : undefined;
  return code === 'FileNotFound' || code === 'ENOENT';
}

function getDirectoryUri(uri: vscode.Uri): vscode.Uri {
  return uri.scheme === 'file'
    ? vscode.Uri.file(path.dirname(uri.fsPath))
    : uri.with({ path: path.posix.dirname(uri.path) });
}

function getSiblingUri(uri: vscode.Uri, fileName: string): vscode.Uri {
  return uri.scheme === 'file'
    ? vscode.Uri.file(path.join(path.dirname(uri.fsPath), fileName))
    : uri.with({ path: path.posix.join(path.posix.dirname(uri.path), fileName) });
}

function getBaseName(uri: vscode.Uri): string {
  return uri.scheme === 'file'
    ? path.basename(uri.fsPath)
    : path.posix.basename(uri.path);
}

export class JsonFileStore<T> implements FileStore<T> {
  constructor(
    private readonly uri: vscode.Uri,
    private readonly label: string,
  ) {}

  async read(): Promise<T | undefined> {
    try {
      const content = await vscode.workspace.fs.readFile(this.uri);
      return JSON.parse(Buffer.from(content).toString('utf-8')) as T;
    } catch (err) {
      if (isFileMissingError(err)) {
        return undefined;
      }
      if (err instanceof SyntaxError) {
        logger.warn(`Failed to parse ${this.label}`, err);
      } else {
        logger.warn(`Failed to read ${this.label}`, err);
      }
      return undefined;
    }
  }

  async write(value: T): Promise<void> {
    const tempFileSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const directoryUri = getDirectoryUri(this.uri);
    const tempUri = getSiblingUri(this.uri, `${getBaseName(this.uri)}.${tempFileSuffix}.tmp`);
    const content = Buffer.from(JSON.stringify(value), 'utf-8');

    await vscode.workspace.fs.createDirectory(directoryUri);
    try {
      await vscode.workspace.fs.writeFile(tempUri, content);
      await vscode.workspace.fs.rename(tempUri, this.uri, { overwrite: true });
    } catch (err) {
      try {
        await vscode.workspace.fs.delete(tempUri, { useTrash: false, recursive: false });
      } catch {
        // Best-effort cleanup only.
      }
      throw err;
    }
  }
}

export class MementoStore<T> implements FileStore<T> {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly key: string,
  ) {}

  async read(): Promise<T | undefined> {
    return this.memento.get<T>(this.key);
  }

  async write(value: T): Promise<void> {
    await this.memento.update(this.key, value);
  }
}

export function createJsonFileStore<T>(
  globalStorageUri: vscode.Uri,
  filename: string,
  label = filename,
): JsonFileStore<T> {
  return new JsonFileStore<T>(vscode.Uri.joinPath(globalStorageUri, filename), label);
}

export function createMementoStore<T>(memento: vscode.Memento, key: string): MementoStore<T> {
  return new MementoStore<T>(memento, key);
}
