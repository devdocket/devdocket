import * as path from 'path';
import { WorkItem, WorkItemState } from '../models/workItem';
import { ITaskStore } from './taskStore';
import { logger } from '../services/logger';
import { SerializedJsonStore } from './serializedJsonStore';
import {
  validateObject,
  requiredString,
  optionalString,
  requiredEnum,
  requiredFiniteNumber,
  optionalFiniteNumber,
  optionalBoolean,
} from './validation';

const validWorkItemStates = new Set<string>(Object.values(WorkItemState));

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
    ?? optionalBoolean(result, 'isPullRequest', ctx)
    ?? optionalString(result, 'providerId', ctx)
    ?? optionalString(result, 'externalId', ctx)
    ?? optionalString(result, 'description', ctx)
    ?? optionalString(result, 'notes', ctx)
    ?? optionalFiniteNumber(result, 'sortOrder', ctx);
  if (err) return err;

  // Validate activityLog entries individually
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
 * Persists {@link WorkItem} objects as a JSON array on disk.
 *
 * All write operations are serialized through an internal queue to prevent
 * concurrent file corruption. An in-memory cache is populated on first load
 * and kept in sync with every mutation.
 */
export class JsonTaskStore extends SerializedJsonStore implements ITaskStore {
  private readonly filePath: string;
  private cache: Map<string, WorkItem> | null = null;
  private loadPromise: Promise<WorkItem[]> | null = null;

  /**
   * @param storagePath - Directory where `workitems.json` will be stored.
   */
  constructor(storagePath: string) {
    super();
    this.filePath = path.join(storagePath, 'workitems.json');
  }

  /**
   * Returns all persisted work items, loading from disk on first call.
   * Subsequent calls return the cached data.
   * @returns All stored work items.
   * @throws If the JSON file exists but cannot be parsed.
   */
  async loadAll(): Promise<WorkItem[]> {
    if (this.cache !== null) {
      return Array.from(this.cache.values());
    }
    // Guard against concurrent loads: reuse the same in-flight promise
    if (this.loadPromise === null) {
      this.loadPromise = this.doLoad();
    }
    return this.loadPromise;
  }

  private async doLoad(): Promise<WorkItem[]> {
    logger.debug(`Loading work items from ${this.filePath}`);
    try {
      const parsed = await this.readJson(this.filePath);
      if (parsed === undefined) {
        this.cache = new Map();
        return [];
      }
      if (!Array.isArray(parsed)) {
        logger.warn('Work items file does not contain an array — backing up and resetting to empty');
        await this.backupFile(this.filePath);
        this.cache = new Map();
        return [];
      }
      // Validate each item and discard invalid entries
      const items: WorkItem[] = [];
      for (let i = 0; i < (parsed as unknown[]).length; i++) {
        const error = validateWorkItem((parsed as unknown[])[i], i);
        if (error) {
          logger.warn(`Skipping invalid work item: ${error}`);
        } else {
          items.push((parsed as unknown[])[i] as WorkItem);
        }
      }
      // Migrate legacy fields
      let needsMigration = false;
      for (const item of items) {
        const legacy = item as WorkItem & { description?: string };
        if (legacy.description !== undefined) {
          if (item.notes === undefined) {
            item.notes = legacy.description;
          }
          delete legacy.description;
          needsMigration = true;
        }
      }
      this.cache = new Map(items.map((item) => [item.id, item]));
      if (needsMigration) {
        await this.enqueue(async () => {
          await this.writeJson(this.filePath, items);
        });
      }
      return items;
    } catch (err: unknown) {
      // Allow retry on failure
      this.loadPromise = null;
      this.cache = null;
      throw err;
    }
  }

  private getCache(): Map<string, WorkItem> {
    if (this.cache === null) {
      throw new Error('Cache not initialized — call loadAll() first');
    }
    return this.cache;
  }

  /**
   * Persists a single work item, inserting or replacing by `id`.
   * @param item - The work item to save.
   * @throws If the write to disk fails (cache is rolled back on error).
   */
  async save(item: WorkItem): Promise<void> {
    logger.debug(`Saving work item: ${item.id}`);
    if (this.cache === null) {
      await this.loadAll();
    }
    return this.enqueue(async () => {
      const cache = this.getCache();
      const previousValue = cache.get(item.id);
      try {
        const items = Array.from(cache.values()).filter(i => i.id !== item.id);
        items.push(item);
        await this.writeJson(this.filePath, items);
        cache.set(item.id, item);
      } catch (err) {
        if (previousValue) {
          cache.set(item.id, previousValue);
        } else {
          cache.delete(item.id);
        }
        throw err;
      }
    });
  }

  /**
   * Persists multiple work items in a single serialized write.
   * @param items - The work items to save (inserted or replaced by `id`).
   * @throws If the write to disk fails (cache is rolled back on error).
   */
  async saveAll(items: WorkItem[]): Promise<void> {
    if (this.cache === null) {
      await this.loadAll();
    }
    return this.enqueue(async () => {
      const cache = this.getCache();
      const previousValues = new Map(items.map(i => [i.id, cache.get(i.id)]));
      try {
        const ids = new Set(items.map(i => i.id));
        const remaining = Array.from(cache.values()).filter(i => !ids.has(i.id));
        remaining.push(...items);
        await this.writeJson(this.filePath, remaining);
        for (const item of items) {
          cache.set(item.id, item);
        }
      } catch (err) {
        for (const [id, prev] of previousValues) {
          if (prev) {
            cache.set(id, prev);
          } else {
            cache.delete(id);
          }
        }
        throw err;
      }
    });
  }

  /**
   * Removes a work item by its ID.
   * @param id - The ID of the work item to delete.
   * @throws If the write to disk fails (cache is rolled back on error).
   */
  async delete(id: string): Promise<void> {
    if (this.cache === null) {
      await this.loadAll();
    }
    return this.enqueue(async () => {
      const cache = this.getCache();
      const previousValue = cache.get(id);
      try {
        cache.delete(id);
        await this.writeJson(this.filePath, Array.from(cache.values()));
      } catch (err) {
        if (previousValue) {
          cache.set(id, previousValue);
        }
        throw err;
      }
    });
  }
}
