import * as fs from 'fs/promises';
import * as path from 'path';
import { WorkItem } from '../models/workItem';
import { ITaskStore } from './taskStore';

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
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      const items = JSON.parse(data) as WorkItem[];
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
    return this.enqueue(async () => {
      if (this.cache === null) {
        await this.loadAll();
      }
      this.cache!.set(item.id, item);
      await this.writeFile(Array.from(this.cache!.values()));
    });
  }

  async delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.cache === null) {
        await this.loadAll();
      }
      this.cache!.delete(id);
      await this.writeFile(Array.from(this.cache!.values()));
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
