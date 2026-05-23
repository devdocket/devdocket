import * as vscode from 'vscode';
import type { ProviderItem } from '../api/types';
import { logger } from '../services/logger';
import type { FileStore } from './fileStore';

const MAX_TOTAL_ENTRIES = 5_000;
const EVICTION_FRACTION = 0.2;

interface PersistedReadStateRecord {
  key: string;
  createdAt: number;
}

function trimReadStateRecords(records: PersistedReadStateRecord[]): PersistedReadStateRecord[] {
  if (records.length <= MAX_TOTAL_ENTRIES) {
    return records;
  }

  const evictedCount = Math.max(
    records.length - MAX_TOTAL_ENTRIES,
    Math.ceil(records.length * EVICTION_FRACTION),
  );
  const keysToEvict = new Set(
    records
      .map((record, index) => ({ ...record, index }))
      .sort((a, b) => a.createdAt - b.createdAt || a.index - b.index)
      .slice(0, evictedCount)
      .map(record => record.key),
  );

  return records.filter(record => !keysToEvict.has(record.key));
}

/**
 * Persists the set of inbox item IDs that the user has viewed ("read")
 * so read/unread state survives across VS Code restarts.
 *
 * Stored as timestamped records in a JSON file under globalStorageUri.
 */
export class ReadStateStore {
  private readonly items = new Map<string, number>();
  private loaded = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever the set of read keys changes (add, addMany, deleteMany, prune). */
  readonly onDidChange = this._onDidChange.event;
  /** Keys added locally since last load — ensures local additions survive remote merges. */
  private readonly addedSinceLoad = new Set<string>();
  /** Keys removed locally since last load — prevents re-adding from stale remote data. */
  private readonly removedSinceLoad = new Set<string>();

  constructor(private readonly fileStore: FileStore<unknown[]>) {}

  has(key: string): boolean {
    return this.items.has(key);
  }

  /**
   * Re-reads from disk, unions with the local set, excludes locally removed
   * keys, and writes the merged result.
   */
  private async persist(): Promise<void> {
    const remoteRecords = await this.parseFromFileStore();
    const remoteKeys = new Set(remoteRecords.map(record => record.key));
    const merged = new Map<string, number>();

    for (const remote of remoteRecords) {
      if (!this.removedSinceLoad.has(remote.key)) {
        merged.set(remote.key, remote.createdAt);
      }
    }

    for (const [key, createdAt] of this.items) {
      if (!this.removedSinceLoad.has(key) && (this.addedSinceLoad.has(key) || remoteKeys.has(key))) {
        merged.set(key, createdAt);
      }
    }

    const trimmed = trimReadStateRecords(
      Array.from(merged, ([key, createdAt]) => ({ key, createdAt })),
    );
    await this.fileStore.write(trimmed);
    this.items.clear();
    for (const record of trimmed) {
      this.items.set(record.key, record.createdAt);
    }
    this.addedSinceLoad.clear();
    this.removedSinceLoad.clear();
  }

  private async parseFromFileStore(): Promise<PersistedReadStateRecord[]> {
    const parsed = await this.fileStore.read();
    if (!Array.isArray(parsed)) {
      return [];
    }

    const records: PersistedReadStateRecord[] = [];
    let invalidCount = 0;
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (typeof item === 'string') {
        records.push({ key: item, createdAt: i });
        continue;
      }

      if (
        typeof item === 'object'
        && item !== null
        && !Array.isArray(item)
        && typeof (item as { key?: unknown }).key === 'string'
        && ((item as { createdAt?: unknown }).createdAt === undefined
          || (typeof (item as { createdAt?: unknown }).createdAt === 'number'
            && Number.isFinite((item as { createdAt?: number }).createdAt)))
      ) {
        const record = item as { key: string; createdAt?: number };
        records.push({ key: record.key, createdAt: record.createdAt ?? i });
        continue;
      }

      invalidCount++;
    }

    if (invalidCount > 0) {
      logger.warn(`Skipped ${invalidCount} invalid read state entries (expected strings or { key, createdAt })`);
    }

    return records;
  }

  /** Returns true only when the key is newly added. Persists automatically. */
  async add(key: string): Promise<boolean> {
    if (!this.loaded) { await this.load(); }
    if (this.items.has(key)) { return false; }
    this.items.set(key, Date.now());
    this.addedSinceLoad.add(key);
    this.removedSinceLoad.delete(key);
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
        this.items.set(key, Date.now());
        this.addedSinceLoad.add(key);
        this.removedSinceLoad.delete(key);
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
    return this.items.keys();
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (!this.loaded) { await this.load(); }
    let changed = false;
    for (const key of keys) {
      if (this.items.delete(key)) {
        changed = true;
        this.addedSinceLoad.delete(key);
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
    for (const key of this.items.keys()) {
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
    const records = await this.parseFromFileStore();
    const trimmedRecords = trimReadStateRecords(records);
    this.items.clear();
    if (trimmedRecords.length !== records.length) {
      await this.fileStore.write(trimmedRecords);
      logger.info(`Trimmed read-state.json from ${records.length} to ${trimmedRecords.length} entries while loading to enforce the ${MAX_TOTAL_ENTRIES}-entry cap`);
    }
    for (const record of trimmedRecords) {
      this.items.set(record.key, record.createdAt);
    }
    if (trimmedRecords.length > 0) {
      logger.debug(`Loaded read state: ${this.items.size} entries`);
    }
    this.addedSinceLoad.clear();
    this.removedSinceLoad.clear();
    this.loaded = true;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  /**
   * Invalidates the in-memory cache so the next access re-reads from disk.
   * Used for cross-window change propagation.
   */
  invalidateCache(): void {
    this.items.clear();
    this.addedSinceLoad.clear();
    this.removedSinceLoad.clear();
    this.loaded = false;
  }
}
