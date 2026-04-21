import * as path from 'path';
import { logger } from '../services/logger';
import { SerializedJsonStore } from './serializedJsonStore';
import type { WatchedRun } from '../services/watcherService';

const WATCHES_FILE = 'watches.json';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * Persists watched pipeline runs as a JSON array on disk.
 * Extends SerializedJsonStore for write-queue serialization and JSON helpers.
 */
export class WatchStore extends SerializedJsonStore {
  private readonly filePath: string;

  constructor(storagePath: string) {
    super();
    this.filePath = path.join(storagePath, WATCHES_FILE);
  }

  /**
   * Load all persisted watches from disk.
   * Returns empty array if file doesn't exist or is invalid.
   */
  async loadAll(): Promise<WatchedRun[]> {
    let parsed: unknown;
    try {
      parsed = await this.readJson(this.filePath, MAX_FILE_SIZE);
    } catch (err) {
      // Swallow non-ENOENT errors (e.g. permission issues) gracefully
      logger.warn('Failed to load watches', err);
      return [];
    }
    if (parsed === undefined) {
      return [];
    }
    if (!Array.isArray(parsed)) {
      logger.warn(`Invalid watches data in ${this.filePath}: expected a JSON array`);
      await this.backupFile(this.filePath);
      return [];
    }
    // Basic validation: each entry must have identifier and status
    return parsed.filter((item: unknown) => {
      if (typeof item !== 'object' || item === null) return false;
      const obj = item as Record<string, unknown>;
      return obj.identifier && obj.status && typeof obj.watchedAt === 'string';
    }) as WatchedRun[];
  }

  /**
   * Save all watches to disk (serialized through write queue).
   */
  async saveAll(watches: WatchedRun[]): Promise<void> {
    return this.enqueue(async () => {
      await this.writeJson(this.filePath, watches);
    });
  }
}
