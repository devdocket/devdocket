import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../services/logger';
import type { WatchedRun } from '../services/watcherService';

const WATCHES_FILE = 'watches.json';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * Persists watched pipeline runs as a JSON array on disk.
 * Follows the write-queue serialization pattern from JsonTaskStore.
 */
export class WatchStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, WATCHES_FILE);
  }

  /**
   * Load all persisted watches from disk.
   * Returns empty array if file doesn't exist or is invalid.
   */
  async loadAll(): Promise<WatchedRun[]> {
    try {
      const stats = await fs.stat(this.filePath);
      if (!stats.isFile() || stats.size > MAX_FILE_SIZE) {
        logger.warn('Watches file invalid or too large — starting fresh');
        return [];
      }
      const data = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        logger.warn('Watches file is not an array — starting fresh');
        return [];
      }
      // Basic validation: each entry must have identifier and status
      return parsed.filter((item: unknown) => {
        if (typeof item !== 'object' || item === null) return false;
        const obj = item as Record<string, unknown>;
        return obj.identifier && obj.status && typeof obj.watchedAt === 'string';
      }) as WatchedRun[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.warn(`Failed to load watches: ${err}`);
      return [];
    }
  }

  /**
   * Save all watches to disk (serialized through write queue).
   */
  async saveAll(watches: WatchedRun[]): Promise<void> {
    return this.enqueueWrite(async () => {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(watches, null, 2), 'utf-8');
    });
  }

  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(fn, fn);
    return this.writeQueue;
  }
}
