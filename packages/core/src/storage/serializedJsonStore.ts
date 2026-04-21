import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../services/logger';
import { MAX_STORE_FILE_SIZE } from './limits';

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Base class for JSON-backed stores with write-queue serialization.
 *
 * All write operations are serialized through an internal promise chain
 * to prevent concurrent file corruption. Subclasses get consistent
 * `enqueue()`, `readJson()`, `writeJson()`, and `backupFile()` helpers.
 */
export abstract class SerializedJsonStore {
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * Serializes an async operation through the write queue. If a previous
   * queued operation failed, logs a warning and continues with the next.
   */
  protected enqueue(op: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(op, (err: unknown) => {
      logger.warn('Previous write operation failed, continuing queue', err);
      return op();
    });
    return this.writeQueue;
  }

  /** Returns a promise that resolves when all queued writes complete. */
  protected flush(): Promise<void> {
    return this.writeQueue;
  }

  /**
   * Reads and parses a JSON file with size-limit and corruption guards.
   *
   * Returns `undefined` when the file is missing, not a regular file,
   * exceeds the size limit, or contains invalid JSON. Corrupt files are
   * backed up automatically; missing files are not.
   */
  protected async readJson(
    filePath: string,
    maxSize: number = MAX_STORE_FILE_SIZE,
  ): Promise<unknown | undefined> {
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        logger.warn(`Store file is not a regular file: ${filePath} — backing up and resetting`);
        await this.backupFile(filePath);
        return undefined;
      }
      if (stats.size > maxSize) {
        logger.warn(`Store file exceeds ${maxSize} bytes: ${filePath} — backing up and resetting`);
        await this.backupFile(filePath);
        return undefined;
      }
      const data = await fs.readFile(filePath, 'utf-8');
      try {
        return JSON.parse(data);
      } catch {
        logger.warn(`Failed to parse store file: ${filePath} — backing up and resetting`);
        await this.backupFile(filePath);
        return undefined;
      }
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Writes `data` as pretty-printed JSON, creating the parent directory if needed.
   */
  protected async writeJson(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Renames a file with a `.corrupt.<timestamp>` suffix for later inspection.
   * Silently swallows rename errors (best-effort backup).
   */
  protected async backupFile(filePath: string): Promise<void> {
    try {
      const backupPath = `${filePath}.corrupt.${Date.now()}`;
      await fs.rename(filePath, backupPath);
      logger.warn(`Backed up invalid store file to ${backupPath}`);
    } catch {
      logger.warn(`Failed to back up invalid store file: ${filePath}`);
    }
  }
}
