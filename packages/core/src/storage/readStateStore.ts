import * as path from 'path';
import { logger } from '../services/logger';
import { SerializedJsonStore } from './serializedJsonStore';

/**
 * Persists the set of inbox item IDs that the user has viewed ("read")
 * so read/unread state survives across VS Code restarts.
 *
 * Stored as a JSON array of composite keys ("providerId::externalId")
 * in read-state.json alongside the other stores.
 */
export class ReadStateStore extends SerializedJsonStore {
  private readonly filePath: string;
  private readonly items = new Set<string>();
  private loaded = false;

  constructor(storagePath: string) {
    super();
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
        await this.writeJson(this.filePath, [...this.items]);
      } catch (err) {
        this.items.delete(key);
        added = false;
        throw err;
      }
    });
    return added;
  }

  /** Adds multiple keys in a single write. Returns keys that were newly added. */
  async addMany(keys: string[]): Promise<string[]> {
    if (keys.length === 0) { return []; }
    if (!this.loaded) { await this.load(); }
    const newlyAdded: string[] = [];
    await this.enqueue(async () => {
      for (const key of keys) {
        if (!this.items.has(key)) {
          this.items.add(key);
          newlyAdded.push(key);
        }
      }
      if (newlyAdded.length === 0) { return; }
      try {
        await this.writeJson(this.filePath, [...this.items]);
      } catch (err) {
        for (const key of newlyAdded) {
          this.items.delete(key);
        }
        newlyAdded.length = 0;
        throw err;
      }
    });
    return newlyAdded;
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
        await this.writeJson(this.filePath, [...this.items]);
      } catch (err) {
        for (const key of actuallyDeleted) {
          this.items.add(key);
        }
        throw err;
      }
    });
  }

  /** Returns a promise that resolves when all queued writes complete. */
  override flush(): Promise<void> {
    return super.flush();
  }

  async load(): Promise<void> {
    if (this.loaded) { return; }
    const parsed = await this.readJson(this.filePath);
    if (parsed === undefined) {
      this.items.clear();
      this.loaded = true;
      return;
    }
    if (!Array.isArray(parsed)) {
      logger.warn('Read state file does not contain an array — backing up and resetting to empty');
      await this.backupFile(this.filePath);
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
  }
}
