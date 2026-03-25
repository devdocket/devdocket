import * as fs from 'fs/promises';
import * as path from 'path';
import { WorkItem } from '../models/workItem';
import { ITaskStore } from './taskStore';
import { logger } from '../services/logger';

export class JsonTaskStore implements ITaskStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private cache: Map<string, WorkItem> | null = null;

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, 'workitems.json');
  }

  async loadAll(): Promise<WorkItem[]> {
    if (this.cache !== null) {
      return Array.from(this.cache.values());
    }
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
      this.cache = new Map(items.map((item) => [item.id, item]));
      return items;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        this.cache = new Map();
        return [];
      }
      throw err;
    }
  }

  async save(item: WorkItem): Promise<void> {
    logger.debug(`Saving work item: ${item.id}`);
    return this.enqueue(async () => {
      if (this.cache === null) {
        await this.loadAll();
      }
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

  async delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.cache === null) {
        await this.loadAll();
      }
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
