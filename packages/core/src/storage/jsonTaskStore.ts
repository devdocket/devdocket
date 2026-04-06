import * as fs from 'fs/promises';
import * as path from 'path';
import { WorkItem } from '../models/workItem';
import { ITaskStore } from './taskStore';
import { logger } from '../services/logger';

/**
 * Persists {@link WorkItem} objects as a JSON array on disk.
 *
 * All write operations are serialized through an internal queue to prevent
 * concurrent file corruption. An in-memory cache is populated on first load
 * and kept in sync with every mutation.
 */
export class JsonTaskStore implements ITaskStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private cache: Map<string, WorkItem> | null = null;
  private loadPromise: Promise<WorkItem[]> | null = null;

  /**
   * @param storagePath - Directory where `workitems.json` will be stored.
   */
  constructor(storagePath: string) {
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
      const data = await fs.readFile(this.filePath, 'utf-8');
      let items: WorkItem[];
      try {
        items = JSON.parse(data) as WorkItem[];
      } catch {
        logger.warn('Failed to parse work items file');
        throw new Error('Failed to parse work items file');
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

  /**
   * Persists multiple work items in a single serialized write.
   * @param items - The work items to save (inserted or replaced by `id`).
   * @throws If the write to disk fails (cache is rolled back on error).
   */
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
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
