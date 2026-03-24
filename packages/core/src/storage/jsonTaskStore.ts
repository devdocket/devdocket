import * as fs from 'fs/promises';
import * as path from 'path';
import { WorkItem } from '../models/workItem';
import { ITaskStore } from './taskStore';

export class JsonTaskStore implements ITaskStore {
  private readonly filePath: string;

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, 'workitems.json');
  }

  async loadAll(): Promise<WorkItem[]> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(data) as WorkItem[];
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async save(item: WorkItem): Promise<void> {
    const items = await this.loadAll();
    const index = items.findIndex((i) => i.id === item.id);
    if (index >= 0) {
      items[index] = item;
    } else {
      items.push(item);
    }
    await this.writeFile(items);
  }

  async delete(id: string): Promise<void> {
    const items = await this.loadAll();
    const filtered = items.filter((i) => i.id !== id);
    await this.writeFile(filtered);
  }

  private async writeFile(items: WorkItem[]): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const data = JSON.stringify(items, null, 2);
    // Write directly — avoid temp+rename which can corrupt on Windows
    await fs.writeFile(this.filePath, data, 'utf-8');
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
