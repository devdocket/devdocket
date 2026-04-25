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
 * every mutation.
 */
export class JsonTaskStore implements ITaskStore {
  private readonly globalState: Memento;
  private cache: Map<string, WorkItem> | null = null;

  constructor(globalState: Memento) {
    this.globalState = globalState;
  }

  async loadAll(): Promise<WorkItem[]> {
    if (this.cache !== null) {
      return Array.from(this.cache.values());
    }
    const parsed = this.globalState.get<unknown[]>(STORAGE_KEY);
    if (!Array.isArray(parsed)) {
      this.cache = new Map();
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
    this.cache = new Map(items.map(item => [item.id, item]));
    return items;
  }

  private getCache(): Map<string, WorkItem> {
    if (this.cache === null) {
      throw new Error('Cache not initialized — call loadAll() first');
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    await this.globalState.update(STORAGE_KEY, Array.from(this.getCache().values()));
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
}
