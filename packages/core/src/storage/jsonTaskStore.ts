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

  constructor(private readonly fileStore: FileStore<unknown[]>) {}

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

  /**
   * Re-reads from disk, adopts untouched remote state, overlays local mutations,
   * and writes the merged result. Local edits use `updatedAt` last-writer-wins
   * for shared items, locally removed items stay deleted, and untouched local
   * items disappear when another window deletes them remotely.
   */
  private async persist(): Promise<void> {
    if (this.cache === null) {
      await this.loadAll();
    }
    const local = this.getCache();
    const remoteItems = await this.parseFromFileStore();
    const remoteById = new Map(remoteItems.map(item => [item.id, item]));
    const merged = new Map<string, WorkItem>();

    for (const remote of remoteItems) {
      const deletedAt = this.deletedUpdatedAt.get(remote.id);
      if (deletedAt !== undefined && remote.updatedAt <= deletedAt) {
        continue;
      }
      merged.set(remote.id, remote);
    }

    for (const [id, localItem] of local) {
      if (this.dirtyIds.has(id) || this.removedIds.has(id)) {
        continue;
      }

      const remoteItem = remoteById.get(id);
      if (remoteItem) {
        continue;
      }

      const syncedUpdatedAt = this.syncedUpdatedAt.get(id);
      if (syncedUpdatedAt !== undefined && localItem.updatedAt !== syncedUpdatedAt) {
        merged.set(id, localItem);
      }
    }

    for (const id of this.removedIds) {
      const remoteItem = merged.get(id);
      const deletedAt = this.deletedUpdatedAt.get(id);
      if (remoteItem && deletedAt !== undefined && remoteItem.updatedAt <= deletedAt) {
        merged.delete(id);
      }
    }

    for (const id of this.dirtyIds) {
      const localItem = local.get(id);
      if (!localItem) {
        continue;
      }
      const remoteItem = merged.get(id);
      if (!remoteItem || localItem.updatedAt >= remoteItem.updatedAt) {
        merged.set(id, localItem);
      }
    }

    await this.fileStore.write(Array.from(merged.values()));
    this.cache = merged;
    this.syncedUpdatedAt = new Map(Array.from(merged.values(), item => [item.id, item.updatedAt]));
    for (const [id, deletedAt] of Array.from(this.deletedUpdatedAt.entries())) {
      const mergedItem = merged.get(id);
      if (mergedItem && mergedItem.updatedAt > deletedAt) {
        this.deletedUpdatedAt.delete(id);
      }
    }
    this.dirtyIds.clear();
    this.removedIds.clear();
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
    await this.persist();
  }

  async saveAll(items: WorkItem[]): Promise<void> {
    if (this.cache === null) { await this.loadAll(); }
    for (const item of items) {
      this.getCache().set(item.id, item);
      this.dirtyIds.add(item.id);
      this.removedIds.delete(item.id);
      this.deletedUpdatedAt.delete(item.id);
    }
    await this.persist();
  }

  async delete(id: string): Promise<void> {
    if (this.cache === null) { await this.loadAll(); }
    if (this.getCache().has(id)) {
      this.deletedUpdatedAt.set(id, Date.now());
    }
    this.getCache().delete(id);
    this.removedIds.add(id);
    this.dirtyIds.delete(id);
    await this.persist();
  }

  /**
   * Invalidates the in-memory cache so the next access re-reads from disk.
   * Used for cross-window change propagation.
   */
  invalidateCache(): void {
    this.cache = null;
    this.syncedUpdatedAt.clear();
    this.deletedUpdatedAt.clear();
    this.dirtyIds.clear();
    this.removedIds.clear();
  }
}
