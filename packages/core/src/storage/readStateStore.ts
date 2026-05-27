import * as vscode from 'vscode';
import type { ProviderItem } from '../api/types';
import { logger } from '../services/logger';
import type { FileStore } from './fileStore';
import { trimByAge } from './trimByAge';

const MAX_TOTAL_ENTRIES = 5_000;

interface PersistedReadStateRecord {
  key: string;
  /** First-seen timestamp used for FIFO eviction of persisted read-state entries. */
  createdAt: number;
}

interface ReadStateSnapshot {
  records: PersistedReadStateRecord[];
  available: boolean;
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
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private flushInProgress: Promise<void> | undefined;
  private disposed = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever the set of read keys changes (add, addMany, deleteMany, prune). */
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidPersist = new vscode.EventEmitter<void>();
  readonly onDidPersist = this._onDidPersist.event;
  /** Keys added locally since the last load or persist — ensures local additions survive remote merges. */
  private readonly addedSinceLoad = new Set<string>();
  /** Keys removed locally since the last load or persist — prevents re-adding from stale remote data. */
  private readonly removedSinceLoad = new Set<string>();

  constructor(
    private readonly fileStore: FileStore<unknown[]>,
    private readonly persistDebounceMs = 250,
  ) {}

  has(key: string): boolean {
    return this.items.has(key);
  }

  private hasPendingPersist(): boolean {
    return this.addedSinceLoad.size > 0 || this.removedSinceLoad.size > 0;
  }

  private schedulePersist(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    if (this.persistDebounceMs <= 0) {
      return this.flush();
    }

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flush().catch(err => logger.error('Failed to flush debounced read state persistence', err));
    }, this.persistDebounceMs);
    return Promise.resolve();
  }

  /** Flushes any pending debounced persistence immediately. */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }

    if (this.flushInProgress) {
      await this.flushInProgress;
    }

    if (!this.hasPendingPersist()) {
      return;
    }

    this.flushInProgress = this.persist().finally(() => {
      this.flushInProgress = undefined;
    });
    await this.flushInProgress;

    if (this.hasPendingPersist()) {
      await this.flush();
    }
  }

  /**
   * Re-reads from disk, unions with the local set, excludes locally removed
   * keys, and writes the merged result.
   */
  private async persist(): Promise<void> {
    const addedKeys = new Set(this.addedSinceLoad);
    const removedKeys = new Set(this.removedSinceLoad);
    const addedRecords = new Map<string, number>();
    for (const key of addedKeys) {
      const createdAt = this.items.get(key);
      if (createdAt !== undefined) {
        addedRecords.set(key, createdAt);
      }
    }

    const snapshot = await this.parseFromFileStore();
    const remoteKeys = new Set(snapshot.records.map(record => record.key));
    const merged = new Map<string, number>();

    if (snapshot.available) {
      for (const remote of snapshot.records) {
        if (!removedKeys.has(remote.key)) {
          merged.set(remote.key, remote.createdAt);
        }
      }
    } else {
      for (const [key, createdAt] of this.items) {
        if (!removedKeys.has(key)) {
          merged.set(key, createdAt);
        }
      }
    }

    for (const [key, createdAt] of this.items) {
      if (!removedKeys.has(key) && (!snapshot.available || addedKeys.has(key) || remoteKeys.has(key))) {
        const existingCreatedAt = merged.get(key);
        merged.set(key, existingCreatedAt === undefined ? createdAt : Math.min(existingCreatedAt, createdAt));
      }
    }

    const trimmed = trimByAge(
      Array.from(merged, ([key, createdAt]) => ({ key, createdAt })),
      {
        maxEntries: MAX_TOTAL_ENTRIES,
        getTimestamp: record => record.createdAt,
        getKey: record => record.key,
      },
    );
    await this.fileStore.write(trimmed);

    for (const [key, createdAt] of addedRecords) {
      if (this.items.get(key) === createdAt) {
        this.addedSinceLoad.delete(key);
      }
    }
    for (const key of removedKeys) {
      if (!this.items.has(key)) {
        this.removedSinceLoad.delete(key);
      }
    }

    const remainingAdded = new Map<string, number>();
    for (const key of this.addedSinceLoad) {
      const createdAt = this.items.get(key);
      if (createdAt !== undefined) {
        remainingAdded.set(key, createdAt);
      }
    }
    const remainingRemoved = new Set(this.removedSinceLoad);

    this.items.clear();
    for (const record of trimmed) {
      this.items.set(record.key, record.createdAt);
    }
    for (const key of remainingRemoved) {
      this.items.delete(key);
    }
    for (const [key, createdAt] of remainingAdded) {
      this.items.set(key, createdAt);
    }
    this._onDidPersist.fire();
  }

  private async parseFromFileStore(): Promise<ReadStateSnapshot> {
    const parsed = await this.fileStore.read();
    if (parsed === undefined) {
      return { records: [], available: false };
    }
    if (!Array.isArray(parsed)) {
      logger.warn('Read state snapshot is not an array; falling back to the in-memory snapshot');
      return { records: [], available: false };
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

    const available = invalidCount === 0;
    if (invalidCount > 0) {
      logger.warn(`Skipped ${invalidCount} invalid read state entries (expected strings or { key, createdAt })`);
    }

    const deduped = new Map<string, PersistedReadStateRecord>();
    for (const record of records) {
      const existing = deduped.get(record.key);
      if (!existing || record.createdAt < existing.createdAt) {
        deduped.set(record.key, record);
      }
    }

    return { records: Array.from(deduped.values()), available };
  }

  /** Returns true only when the key is newly added. Persists automatically. */
  async add(key: string): Promise<boolean> {
    if (!this.loaded) { await this.load(); }
    if (this.items.has(key)) { return false; }
    this.items.set(key, Date.now());
    this.addedSinceLoad.add(key);
    this.removedSinceLoad.delete(key);
    await this.schedulePersist();
    this._onDidChange.fire();
    return true;
  }

  /** Adds multiple keys in a single write. Returns newly added keys that remain persisted after capacity trimming. */
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
      await this.schedulePersist();
      this._onDidChange.fire();
    }
    return newlyAdded.filter(key => this.items.has(key));
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
      await this.schedulePersist();
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

    if (activeProviderIds.size === 0) {
      await this.flush();
      return 0;
    }

    const staleKeys: string[] = [];
    for (const key of this.items.keys()) {
      const delimiterIndex = key.indexOf('::');
      if (delimiterIndex === -1) { continue; }
      const providerId = key.slice(0, delimiterIndex);
      if (activeProviderIds.has(providerId) && !activeKeys.has(key)) {
        staleKeys.push(key);
      }
    }

    if (staleKeys.length === 0) {
      await this.flush();
      return 0;
    }

    for (const key of staleKeys) {
      this.items.delete(key);
      this.addedSinceLoad.delete(key);
      this.removedSinceLoad.add(key);
    }

    await this.flush();
    this._onDidChange.fire();
    return staleKeys.length;
  }

  async load(): Promise<void> {
    if (this.loaded) { return; }
    const snapshot = await this.parseFromFileStore();
    const records = snapshot.records;
    const trimmedRecords = trimByAge(records, {
      maxEntries: MAX_TOTAL_ENTRIES,
      getTimestamp: record => record.createdAt,
      getKey: record => record.key,
    });
    this.items.clear();
    if (trimmedRecords.length !== records.length) {
      try {
        await this.fileStore.write(trimmedRecords);
        logger.info(`Trimmed read-state.json from ${records.length} to ${trimmedRecords.length} entries while loading to enforce the ${MAX_TOTAL_ENTRIES}-entry cap`);
      } catch (err) {
        logger.warn(`Failed to persist trimmed read state while loading; continuing with ${trimmedRecords.length} in-memory entries`, err);
      }
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

  async dispose(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.disposed = true;
      this._onDidChange.dispose();
      this._onDidPersist.dispose();
    }
  }

  /**
   * Invalidates the in-memory cache so the next access re-reads from disk.
   * Used for cross-window change propagation.
   */
  async invalidateCache(): Promise<void> {
    if (this.hasPendingPersist()) {
      await this.flush();
    }
    this.items.clear();
    this.addedSinceLoad.clear();
    this.removedSinceLoad.clear();
    this.loaded = false;
  }
}
