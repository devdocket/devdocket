import * as vscode from 'vscode';
import type { Memento } from 'vscode';
import type { ProviderItem } from '../api/types';
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
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever the set of read keys changes (add, addMany, deleteMany, prune). */
  readonly onDidChange = this._onDidChange.event;
  /** Keys removed locally since last load — prevents re-adding from stale remote data. */
  private readonly removedSinceLoad = new Set<string>();

  constructor(globalState: Memento) {
    this.globalState = globalState;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  /**
   * Re-reads from globalState, unions with local set, excludes locally
   * removed keys, and writes the merged result.
   */
  private async persist(): Promise<void> {
    const remoteParsed = this.globalState.get<unknown[]>(STORAGE_KEY);
    const merged = new Set(this.items);
    if (Array.isArray(remoteParsed)) {
      for (const item of remoteParsed) {
        if (typeof item === 'string' && !this.removedSinceLoad.has(item)) {
          merged.add(item);
        }
      }
    }
    await this.globalState.update(STORAGE_KEY, [...merged]);
    this.items.clear();
    for (const key of merged) {
      this.items.add(key);
    }
    this.removedSinceLoad.clear();
  }

  /** Returns true only when the key is newly added. Persists automatically. */
  async add(key: string): Promise<boolean> {
    if (!this.loaded) { await this.load(); }
    if (this.items.has(key)) { return false; }
    this.items.add(key);
    await this.persist();
    this._onDidChange.fire();
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
      this._onDidChange.fire();
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
      if (this.items.delete(key)) {
        changed = true;
        this.removedSinceLoad.add(key);
      }
    }
    if (changed) {
      await this.persist();
      this._onDidChange.fire();
    }
  }

  /**
   * Removes persisted read keys for items that are no longer reported by
   * their provider. Providers with empty item arrays are skipped to avoid
   * pruning during transient API failures.
   *
   * @returns The number of records removed.
   */
  async prune(activeItems: Map<string, ProviderItem[]>): Promise<number> {
    if (!this.loaded) { await this.load(); }

    const activeKeys = new Set<string>();
    const activeProviderIds = new Set<string>();
    for (const [providerId, items] of activeItems) {
      if (items.length === 0) { continue; }
      activeProviderIds.add(providerId);
      for (const item of items) {
        activeKeys.add(`${providerId}::${item.externalId}`);
      }
    }

    if (activeProviderIds.size === 0) { return 0; }

    const staleKeys: string[] = [];
    for (const key of this.items) {
      const delimiterIndex = key.indexOf('::');
      if (delimiterIndex === -1) { continue; }
      const providerId = key.slice(0, delimiterIndex);
      if (activeProviderIds.has(providerId) && !activeKeys.has(key)) {
        staleKeys.push(key);
      }
    }

    if (staleKeys.length === 0) { return 0; }

    for (const key of staleKeys) {
      this.items.delete(key);
      this.removedSinceLoad.add(key);
    }

    await this.persist();
    this._onDidChange.fire();
    return staleKeys.length;
  }

  async load(): Promise<void> {
    if (this.loaded) { return; }
    const parsed = this.globalState.get<unknown[]>(STORAGE_KEY);
    this.items.clear();
    if (Array.isArray(parsed)) {
      let invalidCount = 0;
      for (const item of parsed) {
        if (typeof item === 'string') {
          this.items.add(item);
        } else {
          invalidCount++;
        }
      }
      if (invalidCount > 0) {
        logger.warn(`Skipped ${invalidCount} invalid read state entries (expected strings)`);
      }
      logger.debug(`Loaded read state: ${this.items.size} entries`);
    }
    this.removedSinceLoad.clear();
    this.loaded = true;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  /**
   * Invalidates the in-memory cache so the next access re-reads from
   * globalState. Used for cross-window change propagation.
   */
  invalidateCache(): void {
    this.items.clear();
    this.removedSinceLoad.clear();
    this.loaded = false;
  }
}
