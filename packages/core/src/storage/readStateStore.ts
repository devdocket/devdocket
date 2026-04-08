import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../services/logger';

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
  deleteMany(keys: string[]): void {
    this.enqueue(async () => {
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
        logger.error('Failed to save read state, rolled back deletions', err);
      }
    }).catch(() => {
      // Error already handled inside enqueue with rollback
    });
  }

  /** Returns a promise that resolves when all queued writes complete. */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  async load(): Promise<void> {
    if (this.loaded) { return; }
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      const arr = JSON.parse(data) as string[];
      this.items.clear();
      for (const key of arr) {
        this.items.add(key);
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
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
