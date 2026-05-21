import type { Memento } from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { ITaskStore } from './taskStore';
import { logger } from '../services/logger';
import {
  validateObject,
  requiredString,
  optionalString,
  requiredEnum,
  requiredFiniteNumber,
  optionalFiniteNumber,
} from './validation';

const STORAGE_KEY = 'devdocket.workitems';
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
 * Persists {@link WorkItem} objects in VS Code globalState.
 *
 * An in-memory cache is populated on first load and kept in sync with
 * every mutation. On persist, the store re-reads from globalState and
 * merges to avoid clobbering changes made by other VS Code windows.
 */
export class JsonTaskStore implements ITaskStore {
  private readonly globalState: Memento;
  private cache: Map<string, WorkItem> | null = null;
  /** IDs known at load time — used to distinguish "deleted locally" from "added remotely". */
  private loadedIds = new Set<string>();

  constructor(globalState: Memento) {
    this.globalState = globalState;
  }

  async loadAll(): Promise<WorkItem[]> {
    if (this.cache !== null) {
      return Array.from(this.cache.values());
    }
    const items = this.parseFromGlobalState();
    this.cache = new Map(items.map(item => [item.id, item]));
    this.loadedIds = new Set(this.cache.keys());
    return items;
  }

  private getCache(): Map<string, WorkItem> {
    if (this.cache === null) {
      throw new Error('Cache not initialized — call loadAll() first');
    }
    return this.cache;
  }

  /**
   * Re-reads from globalState, merges remote items with the local cache,
   * and writes the merged result. Items modified locally (by `updatedAt`)
   * take precedence. Items added remotely (not in loadedIds) are preserved.
   * Items deleted locally (in loadedIds but not in cache) stay deleted.
   */
  private async persist(): Promise<void> {
    if (this.cache === null) {
      await this.loadAll();
    }
    const local = this.getCache();
    const remoteItems = this.parseFromGlobalState();
    const merged = new Map(local);

    for (const remote of remoteItems) {
      if (merged.has(remote.id)) {
        // Both windows have this item — keep the one with the later updatedAt
        const localItem = merged.get(remote.id)!;
        if (remote.updatedAt > localItem.updatedAt) {
          merged.set(remote.id, remote);
        }
      } else if (!this.loadedIds.has(remote.id)) {
        // Remote has an item we never saw — added by another window
        merged.set(remote.id, remote);
      }
      // else: item was in loadedIds but deleted from local cache — locally deleted
    }

    this.cache = merged;
    // Track newly discovered remote IDs so future persists can distinguish
    // "deleted locally" from "never seen"
    for (const id of merged.keys()) {
      this.loadedIds.add(id);
    }
    await this.globalState.update(STORAGE_KEY, Array.from(merged.values()));
  }

  /** Parse and validate work items from globalState. */
  private parseFromGlobalState(): WorkItem[] {
    const parsed = this.globalState.get<unknown[]>(STORAGE_KEY);
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
    await this.persist();
  }

  async saveAll(items: WorkItem[]): Promise<void> {
    if (this.cache === null) { await this.loadAll(); }
    for (const item of items) {
      this.getCache().set(item.id, item);
    }
    await this.persist();
  }

  async delete(id: string): Promise<void> {
    if (this.cache === null) { await this.loadAll(); }
    this.getCache().delete(id);
    await this.persist();
  }

  /**
   * Invalidates the in-memory cache so the next access re-reads from
   * globalState. Used for cross-window change propagation.
   */
  invalidateCache(): void {
    this.cache = null;
    this.loadedIds.clear();
  }
}
