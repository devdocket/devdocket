import type { Memento } from 'vscode';
import { logger } from '../services/logger';

const STORAGE_KEY = 'devdocket.read-state';

/**
 * Persists the set of inbox item IDs that the user has viewed ("read")
 * so read/unread state survives across VS Code restarts.
 *
 * Stored as a string array in VS Code globalState under the key
 * "devdocket.read-state".
 */
export class ReadStateStore {
  private readonly globalState: Memento;
  private readonly items = new Set<string>();
  private loaded = false;

  constructor(globalState: Memento) {
    this.globalState = globalState;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  private async persist(): Promise<void> {
    await this.globalState.update(STORAGE_KEY, [...this.items]);
  }

  /** Returns true only when the key is newly added. Persists automatically. */
  async add(key: string): Promise<boolean> {
    if (!this.loaded) { await this.load(); }
    if (this.items.has(key)) { return false; }
    this.items.add(key);
    await this.persist();
    return true;
  }

  /** Adds multiple keys in a single write. Returns keys that were newly added. */
  async addMany(keys: string[]): Promise<string[]> {
    if (keys.length === 0) { return []; }
    if (!this.loaded) { await this.load(); }
    const newlyAdded: string[] = [];
    for (const key of keys) {
      if (!this.items.has(key)) {
        this.items.add(key);
        newlyAdded.push(key);
      }
    }
    if (newlyAdded.length > 0) {
      await this.persist();
    }
    return newlyAdded;
  }

  keys(): IterableIterator<string> {
    return this.items.values();
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (!this.loaded) { await this.load(); }
    let changed = false;
    for (const key of keys) {
      if (this.items.delete(key)) { changed = true; }
    }
    if (changed) {
      await this.persist();
    }
  }

  /** No-op — globalState writes are immediate. */
  async flush(): Promise<void> {}

  async load(): Promise<void> {
    if (this.loaded) { return; }
    const parsed = this.globalState.get<unknown[]>(STORAGE_KEY);
    this.items.clear();
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'string') {
          this.items.add(item);
        } else {
          logger.warn(`Skipping invalid read state entry: expected string, got ${typeof item}`);
        }
      }
      logger.debug(`Loaded read state: ${this.items.size} entries`);
    }
    this.loaded = true;
  }
}
