import * as fs from 'fs/promises';
import * as path from 'path';
import { WorkItem, WorkItemState } from '../models/workItem';
import { ITaskStore } from './taskStore';
import { logger } from '../services/logger';

const validWorkItemStates = new Set<string>(Object.values(WorkItemState));

/**
 * Validates that a parsed JSON value has the required shape of a WorkItem.
 * Returns a descriptive error string if invalid, or undefined if valid.
 */
function validateWorkItem(value: unknown, index: number): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return `Item at index ${index} is not an object`;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    return `Item at index ${index} is missing a valid "id" (string)`;
  }
  if (typeof obj.title !== 'string' || obj.title.length === 0) {
    return `Item "${obj.id}" at index ${index} is missing a valid "title" (string)`;
  }
  if (typeof obj.state !== 'string' || !validWorkItemStates.has(obj.state)) {
    return `Item "${obj.id}" at index ${index} has invalid "state": ${JSON.stringify(obj.state)}`;
  }
  if (typeof obj.createdAt !== 'number' || !Number.isFinite(obj.createdAt)) {
    return `Item "${obj.id}" at index ${index} is missing a valid "createdAt" (finite number)`;
  }
  if (typeof obj.updatedAt !== 'number' || !Number.isFinite(obj.updatedAt)) {
    return `Item "${obj.id}" at index ${index} is missing a valid "updatedAt" (finite number)`;
  }
  return undefined;
}

export class JsonTaskStore implements ITaskStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private cache: Map<string, WorkItem> | null = null;
  private loadPromise: Promise<WorkItem[]> | null = null;

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, 'workitems.json');
  }

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
      const data = await fs.readFile(this.filePath, 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        logger.warn('Failed to parse work items file — backing up and resetting to empty');
        await this.backupCorruptedFile();
        this.cache = new Map();
        return [];
      }
      if (!Array.isArray(parsed)) {
        logger.warn('Work items file does not contain an array — resetting to empty');
        parsed = [];
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
      // Migrate legacy 'description' field to 'notes'
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
          await this.writeFile(items);
        });
      }
      return items;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        this.cache = new Map();
        return [];
      }
      // Allow retry on failure
      this.loadPromise = null;
      this.cache = null;
      throw err;
    }
  }

  async save(item: WorkItem): Promise<void> {
    logger.debug(`Saving work item: ${item.id}`);
    if (this.cache === null) {
      await this.loadAll();
    }
    return this.enqueue(async () => {
      const previousValue = this.cache!.get(item.id);
      try {
        const items = Array.from(this.cache!.values()).filter(i => i.id !== item.id);
        items.push(item);
        await this.writeFile(items);
        this.cache!.set(item.id, item);
      } catch (err) {
        if (previousValue) {
          this.cache!.set(item.id, previousValue);
        } else {
          this.cache!.delete(item.id);
        }
        throw err;
      }
    });
  }

  async saveAll(items: WorkItem[]): Promise<void> {
    return this.enqueue(async () => {
      if (this.cache === null) {
        await this.loadAll();
      }
      const previousValues = new Map(items.map(i => [i.id, this.cache!.get(i.id)]));
      try {
        const ids = new Set(items.map(i => i.id));
        const remaining = Array.from(this.cache!.values()).filter(i => !ids.has(i.id));
        remaining.push(...items);
        await this.writeFile(remaining);
        for (const item of items) {
          this.cache!.set(item.id, item);
        }
      } catch (err) {
        for (const [id, prev] of previousValues) {
          if (prev) {
            this.cache!.set(id, prev);
          } else {
            this.cache!.delete(id);
          }
        }
        throw err;
      }
    });
  }

  async delete(id: string): Promise<void> {
    if (this.cache === null) {
      await this.loadAll();
    }
    return this.enqueue(async () => {
      const previousValue = this.cache!.get(id);
      try {
        this.cache!.delete(id);
        await this.writeFile(Array.from(this.cache!.values()));
      } catch (err) {
        if (previousValue) {
          this.cache!.set(id, previousValue);
        }
        throw err;
      }
    });
  }

  private async writeFile(items: WorkItem[]): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const data = JSON.stringify(items, null, 2);
    await fs.writeFile(this.filePath, data, 'utf-8');
  }

  // Serialize all write operations to prevent concurrent file corruption
  private enqueue(op: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(op, op);
    return this.writeQueue;
  }

  private async backupCorruptedFile(): Promise<void> {
    try {
      const backupPath = `${this.filePath}.corrupt.${Date.now()}`;
      await fs.rename(this.filePath, backupPath);
      logger.warn(`Backed up corrupted file to ${backupPath}`);
    } catch {
      logger.warn('Failed to back up corrupted work items file');
    }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
