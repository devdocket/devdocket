import { WorkItem, WorkItemState } from '../models/workItem';
import { ITaskStore } from './taskStore';
import { logger } from '../services/logger';
import type { FileStore } from './fileStore';
import {
  validateObject,
  requiredString,
  optionalString,
  requiredEnum,
  requiredFiniteNumber,
  optionalFiniteNumber,
} from './validation';

const validWorkItemStates = new Set<string>(Object.values(WorkItemState));
const validItemTypes = new Set(['issue', 'pr']);

/**
 * Validates that a parsed JSON value has the required shape of a WorkItem.
 * Returns a descriptive error string if invalid, or undefined if valid.
 */
function validateWorkItem(value: unknown, index: number): string | undefined {
  const result = validateObject(value, `Item at index ${index}`);
  if (typeof result === 'string') return result;

  let err = requiredString(result, 'id', `Item at index ${index}`);
  if (err) return err;

  const ctx = `Item "${result.id}" at index ${index}`;
  err = requiredString(result, 'title', ctx)
    ?? requiredEnum(result, 'state', validWorkItemStates, ctx)
    ?? requiredFiniteNumber(result, 'createdAt', ctx)
    ?? requiredFiniteNumber(result, 'updatedAt', ctx)
    ?? optionalString(result, 'url', ctx)
    ?? optionalString(result, 'providerId', ctx)
    ?? optionalString(result, 'externalId', ctx)
    ?? optionalString(result, 'description', ctx)
    ?? optionalString(result, 'notes', ctx)
    ?? optionalFiniteNumber(result, 'sortOrder', ctx);
  if (err) return err;

  if (result.itemType !== undefined && !validItemTypes.has(String(result.itemType))) {
    return `${ctx} has invalid "itemType"`;
  }

  if (result.activityLog !== undefined) {
    if (!Array.isArray(result.activityLog)) {
      return `${ctx} has invalid "activityLog" (array expected)`;
    }
    for (let j = 0; j < (result.activityLog as unknown[]).length; j++) {
      const entry = (result.activityLog as unknown[])[j];
      const entryResult = validateObject(entry, `${ctx} activityLog entry at position ${j}`);
      if (typeof entryResult === 'string') return entryResult;

      const entryCtx = `${ctx} activityLog[${j}]`;
      const entryErr = requiredFiniteNumber(entryResult, 'timestamp', entryCtx)
        ?? requiredString(entryResult, 'type', entryCtx)
        ?? optionalString(entryResult, 'detail', entryCtx);
      if (entryErr) return entryErr;
    }
  }
  return undefined;
}

/**
 * Persists {@link WorkItem} objects in a JSON file under globalStorageUri.
 *
 * An in-memory cache is populated on first load and kept in sync with
 * every mutation. On persist, the store re-reads from disk and merges to
 * avoid clobbering changes made by other VS Code windows.
 */
export class JsonTaskStore implements ITaskStore {
  private cache: Map<string, WorkItem> | null = null;
  /** IDs modified locally since the last successful persist. */
  private dirtyIds = new Set<string>();
  /** IDs deleted locally since the last successful persist. */
  private removedIds = new Set<string>();
  /** Last persisted or loaded updatedAt value for each known item. */
  private syncedUpdatedAt = new Map<string, number>();
  /** Local delete tombstones used to suppress stale reintroductions from other windows. */
  private deletedUpdatedAt = new Map<string, number>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistQueued = false;
  private persistInFlight = false;
  private persistRunQueued = false;
  private persistChain: Promise<void> = Promise.resolve();
  private lastPersistError: unknown;

  constructor(
    private readonly fileStore: FileStore<unknown[]>,
    private readonly options: { persistDelayMs?: number } = {},
  ) {}

  async loadAll(): Promise<WorkItem[]> {
    if (this.cache !== null) {
      return Array.from(this.cache.values());
    }
    const items = await this.parseFromFileStore();
    this.cache = new Map(items.map(item => [item.id, item]));
    this.syncedUpdatedAt = new Map(items.map(item => [item.id, item.updatedAt]));
    this.dirtyIds.clear();
    this.removedIds.clear();
    return items;
  }

  private getCache(): Map<string, WorkItem> {
    if (this.cache === null) {
      throw new Error('Cache not initialized — call loadAll() first');
    }
    return this.cache;
  }

  private getPersistDelayMs(): number {
    return this.options.persistDelayMs ?? 25;
  }

  private schedulePersist(): void {
    this.persistQueued = true;
    if (this.persistTimer || this.persistInFlight || this.persistRunQueued) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.enqueuePersistRun();
    }, this.getPersistDelayMs());
  }

  private enqueuePersistRun(): void {
    if (this.persistInFlight || this.persistRunQueued) {
      return;
    }

    this.persistRunQueued = true;
    const run = this.persistChain
      .catch(() => undefined)
      .then(() => this.runPersistLoop());

    run.then(
      () => {
        this.persistRunQueued = false;
        if (this.persistChain === run) {
          this.lastPersistError = undefined;
        }
      },
      (err) => {
        this.persistRunQueued = false;
        this.lastPersistError = err;
        logger.error('Failed to persist work items', err);
      },
    );

    this.persistChain = run;
  }

  private async runPersistLoop(): Promise<void> {
    if (this.persistInFlight) {
      return;
    }

    this.persistInFlight = true;
    try {
      while (this.persistQueued) {
        this.persistQueued = false;
        try {
          await this.persistOnce();
        } catch (err) {
          this.persistQueued = true;
          throw err;
        }
      }
    } finally {
      this.persistInFlight = false;
      if (this.persistQueued && !this.persistTimer) {
        this.persistTimer = setTimeout(() => {
          this.persistTimer = undefined;
          this.enqueuePersistRun();
        }, this.getPersistDelayMs());
      }
    }
  }

  /**
   * Re-reads from disk, adopts untouched remote state, overlays local mutations,
   * and writes the merged result. Local edits use `updatedAt` last-writer-wins
   * for shared items, locally removed items stay deleted, and untouched local
   * items disappear when another window deletes them remotely.
   */
  private async persistOnce(): Promise<void> {
    if (this.cache === null) {
      await this.loadAll();
    }
    const localSnapshot = new Map(this.getCache());
    const dirtyIdsSnapshot = new Set(this.dirtyIds);
    const removedIdsSnapshot = new Set(this.removedIds);
    const syncedUpdatedAtSnapshot = new Map(this.syncedUpdatedAt);
    const deletedUpdatedAtSnapshot = new Map(this.deletedUpdatedAt);
    const remoteItems = await this.parseFromFileStore();
    const remoteById = new Map(remoteItems.map(item => [item.id, item]));
    const merged = new Map<string, WorkItem>();

    for (const remote of remoteItems) {
      const deletedAt = deletedUpdatedAtSnapshot.get(remote.id);
      if (deletedAt !== undefined && remote.updatedAt <= deletedAt) {
        continue;
      }
      merged.set(remote.id, remote);
    }

    for (const [id, localItem] of localSnapshot) {
      if (dirtyIdsSnapshot.has(id) || removedIdsSnapshot.has(id)) {
        continue;
      }

      const remoteItem = remoteById.get(id);
      if (remoteItem) {
        continue;
      }

      const syncedUpdatedAt = syncedUpdatedAtSnapshot.get(id);
      if (syncedUpdatedAt !== undefined && localItem.updatedAt !== syncedUpdatedAt) {
        merged.set(id, localItem);
      }
    }

    for (const id of removedIdsSnapshot) {
      const remoteItem = merged.get(id);
      const deletedAt = deletedUpdatedAtSnapshot.get(id);
      if (remoteItem && deletedAt !== undefined && remoteItem.updatedAt <= deletedAt) {
        merged.delete(id);
      }
    }

    for (const id of dirtyIdsSnapshot) {
      const localItem = localSnapshot.get(id);
      if (!localItem) {
        continue;
      }
      const remoteItem = merged.get(id);
      if (!remoteItem || localItem.updatedAt >= remoteItem.updatedAt) {
        merged.set(id, localItem);
      }
    }

    await this.fileStore.write(Array.from(merged.values()));

    const currentCache = this.getCache();
    for (const [id, snapshotItem] of localSnapshot) {
      if (currentCache.get(id) !== snapshotItem) {
        continue;
      }

      const persistedItem = merged.get(id);
      if (persistedItem) {
        currentCache.set(id, persistedItem);
      } else {
        currentCache.delete(id);
      }
    }

    for (const [id, snapshotItem] of localSnapshot) {
      if (dirtyIdsSnapshot.has(id)) {
        const currentItem = currentCache.get(id);
        const persistedItem = merged.get(id);
        if (currentItem === persistedItem && persistedItem !== undefined) {
          this.syncedUpdatedAt.set(id, persistedItem.updatedAt);
          this.dirtyIds.delete(id);
        } else if (currentItem === snapshotItem && persistedItem === undefined) {
          this.syncedUpdatedAt.delete(id);
          this.dirtyIds.delete(id);
        }
      }
    }

    for (const id of removedIdsSnapshot) {
      if (!currentCache.has(id)) {
        this.syncedUpdatedAt.delete(id);
        this.removedIds.delete(id);
      }
    }

    for (const [id, persistedItem] of merged) {
      if (!currentCache.has(id) && !this.removedIds.has(id)) {
        currentCache.set(id, persistedItem);
      }
    }

    for (const [id, persistedItem] of merged) {
      const currentItem = currentCache.get(id);
      if (currentItem === persistedItem && !this.dirtyIds.has(id) && !this.removedIds.has(id)) {
        this.syncedUpdatedAt.set(id, persistedItem.updatedAt);
      }
    }

    for (const id of Array.from(this.syncedUpdatedAt.keys())) {
      if (!merged.has(id) && !this.dirtyIds.has(id) && !this.removedIds.has(id)) {
        this.syncedUpdatedAt.delete(id);
      }
    }

    for (const [id, deletedAt] of Array.from(this.deletedUpdatedAt.entries())) {
      const mergedItem = merged.get(id);
      if (mergedItem && mergedItem.updatedAt > deletedAt) {
        this.deletedUpdatedAt.delete(id);
      }
    }
  }

  /** Parse and validate work items from the backing JSON file. */
  private async parseFromFileStore(): Promise<WorkItem[]> {
    const parsed = await this.fileStore.read();
    if (!Array.isArray(parsed)) {
      return [];
    }
    const items: WorkItem[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const error = validateWorkItem(parsed[i], i);
      if (error) {
        logger.warn(`Skipping invalid work item: ${error}`);
      } else {
        items.push(parsed[i] as WorkItem);
      }
    }
    return items;
  }

  async save(item: WorkItem): Promise<void> {
    if (this.cache === null) { await this.loadAll(); }
    this.getCache().set(item.id, item);
    this.dirtyIds.add(item.id);
    this.removedIds.delete(item.id);
    this.deletedUpdatedAt.delete(item.id);
    this.schedulePersist();
  }

  async saveAll(items: WorkItem[]): Promise<void> {
    if (this.cache === null) { await this.loadAll(); }
    for (const item of items) {
      this.getCache().set(item.id, item);
      this.dirtyIds.add(item.id);
      this.removedIds.delete(item.id);
      this.deletedUpdatedAt.delete(item.id);
    }
    this.schedulePersist();
  }

  async delete(id: string): Promise<void> {
    if (this.cache === null) { await this.loadAll(); }
    if (this.getCache().has(id)) {
      this.deletedUpdatedAt.set(id, Date.now());
    }
    this.getCache().delete(id);
    this.removedIds.add(id);
    this.dirtyIds.delete(id);
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      this.enqueuePersistRun();
    }

    while (true) {
      if (this.persistQueued && !this.persistInFlight && !this.persistRunQueued) {
        this.enqueuePersistRun();
      }

      const persistChain = this.persistChain;
      await persistChain;

      if (this.lastPersistError !== undefined) {
        throw this.lastPersistError;
      }

      if (!this.persistTimer && !this.persistQueued && !this.persistInFlight && persistChain === this.persistChain) {
        return;
      }
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = undefined;
        this.enqueuePersistRun();
      }
    }
  }

  /**
   * Invalidates the in-memory cache so the next access re-reads from disk.
   * Used for cross-window change propagation.
   */
  async invalidateCache(): Promise<void> {
    await this.flush();
    this.cache = null;
    this.syncedUpdatedAt.clear();
    this.deletedUpdatedAt.clear();
    this.dirtyIds.clear();
    this.removedIds.clear();
  }
}
