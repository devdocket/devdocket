import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../services/logger';
import { MAX_STORE_FILE_SIZE } from './limits';

/**
 * Persists the set of inbox item IDs that the user has viewed ("read")
 * so read/unread state survives across VS Code restarts.
 *
 * Stored as a JSON array of composite keys ("providerId::externalId")
 * in read-state.json alongside the other stores.
 */
export class ReadStateStore {
  private readonly filePath: string;
  private readonly items = new Set<string>();
  private writeQueue: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, 'read-state.json');
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  /** Returns true only when the key is newly added. Persists automatically. */
  async add(key: string): Promise<boolean> {
    if (!this.loaded) { await this.load(); }
    let added = false;
    await this.enqueue(async () => {
      if (this.items.has(key)) { return; }
      this.items.add(key);
      added = true;
      try {
        await this.writeFile();
      } catch (err) {
        this.items.delete(key);
        added = false;
        throw err;
      }
    });
    return added;
  }

  keys(): IterableIterator<string> {
    return this.items.values();
  }

  /**
   * Atomically delete keys and persist, with rollback on write failure.
   * Both deletes and write are serialized through the writeQueue.
   */
  async deleteMany(keys: string[]): Promise<void> {
    if (!this.loaded) { await this.load(); }
    return this.enqueue(async () => {
      const actuallyDeleted: string[] = [];
      for (const key of keys) {
        if (this.items.delete(key)) {
          actuallyDeleted.push(key);
        }
      }
      if (actuallyDeleted.length === 0) { return; }
      try {
        await this.writeFile();
      } catch (err) {
        for (const key of actuallyDeleted) {
          this.items.add(key);
        }
        throw err;
      }
    });
  }

  /** Returns a promise that resolves when all queued writes complete. */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  async load(): Promise<void> {
    if (this.loaded) { return; }
    try {
      const stats = await fs.stat(this.filePath);
      if (!stats.isFile()) {
        logger.warn('Read state path is not a regular file — backing up and resetting to empty');
        await this.backupInvalidFile();
        this.items.clear();
        this.loaded = true;
        return;
      }
      if (stats.size > MAX_STORE_FILE_SIZE) {
        logger.warn(`Read state file exceeds ${MAX_STORE_FILE_SIZE} bytes — backing up and resetting to empty`);
        await this.backupInvalidFile();
        this.items.clear();
        this.loaded = true;
        return;
      }
      const data = await fs.readFile(this.filePath, 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        logger.warn('Failed to parse read state file — backing up and resetting to empty');
        await this.backupInvalidFile();
        this.items.clear();
        this.loaded = true;
        return;
      }
      if (!Array.isArray(parsed)) {
        logger.warn('Read state file does not contain an array — backing up and resetting to empty');
        await this.backupInvalidFile();
        this.items.clear();
        this.loaded = true;
        return;
      }
      this.items.clear();
      const maxInvalidEntryWarnings = 5;
      let invalidEntryCount = 0;
      for (const item of parsed) {
        if (typeof item !== 'string') {
          invalidEntryCount += 1;
          if (invalidEntryCount <= maxInvalidEntryWarnings) {
            logger.warn(`Skipping invalid read state entry: expected string, got ${typeof item}`);
          }
          continue;
        }
        this.items.add(item);
      }
      if (invalidEntryCount > 0) {
        const suppressed = invalidEntryCount - maxInvalidEntryWarnings;
        if (suppressed > 0) {
          logger.warn(`Skipped ${invalidEntryCount} invalid read state entries (${suppressed} additional warnings suppressed)`);
        } else {
          logger.warn(`Skipped ${invalidEntryCount} invalid read state entr${invalidEntryCount === 1 ? 'y' : 'ies'}`);
        }
      }
      logger.debug(`Loaded read state: ${this.items.size} entries`);
      this.loaded = true;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        this.items.clear();
        this.loaded = true;
        return;
      }
      throw err;
    }
  }

  private async writeFile(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const data = JSON.stringify([...this.items], null, 2);
    await fs.writeFile(this.filePath, data, 'utf-8');
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(op, op);
    return this.writeQueue;
  }

  private async backupInvalidFile(): Promise<void> {
    try {
      const backupPath = `${this.filePath}.corrupt.${Date.now()}`;
      await fs.rename(this.filePath, backupPath);
      logger.warn(`Backed up invalid read state file to ${backupPath}`);
    } catch {
      logger.warn('Failed to back up invalid read state file');
    }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
