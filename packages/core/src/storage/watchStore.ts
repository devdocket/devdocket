import * as path from 'path';
import { logger } from '../services/logger';
import { SerializedJsonStore } from './serializedJsonStore';
import type { WatchedRun, WatchedPR } from '../services/watcherService';

const WATCHES_FILE = 'watches.json';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * On-disk shape: either a legacy plain array of WatchedRun, or the
 * new envelope with separate `runs` and `prs` arrays.
 */
interface WatchStoreData {
  runs: WatchedRun[];
  prs: WatchedPR[];
}

/**
 * Persists watched pipeline runs and PR watches as JSON on disk.
 * Extends SerializedJsonStore for write-queue serialization and JSON helpers.
 *
 * Migrates legacy files (plain JSON array) to the new envelope format.
 */
export class WatchStore extends SerializedJsonStore {
  private readonly filePath: string;

  constructor(storagePath: string) {
    super();
    this.filePath = path.join(storagePath, WATCHES_FILE);
  }

  /**
   * Load all persisted data from disk.
   * Returns empty arrays if file doesn't exist or is invalid.
   * Transparently migrates legacy plain-array format.
   */
  async loadAll(): Promise<WatchStoreData> {
    let parsed: unknown;
    try {
      parsed = await this.readJson(this.filePath, MAX_FILE_SIZE);
    } catch (err) {
      logger.warn('Failed to load watches', err);
      return { runs: [], prs: [] };
    }
    if (parsed === undefined) {
      return { runs: [], prs: [] };
    }

    // Legacy migration: plain array → envelope
    if (Array.isArray(parsed)) {
      const runs = parsed.filter((item: unknown) => {
        if (typeof item !== 'object' || item === null) return false;
        const obj = item as Record<string, unknown>;
        return obj.identifier && obj.status && typeof obj.watchedAt === 'string';
      }) as WatchedRun[];
      return { runs, prs: [] };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      logger.warn(`Invalid watches data in ${this.filePath}: expected an object or array`);
      await this.backupFile(this.filePath);
      return { runs: [], prs: [] };
    }

    const data = parsed as Record<string, unknown>;
    const runs = Array.isArray(data.runs)
      ? (data.runs as unknown[]).filter((item: unknown) => {
          if (typeof item !== 'object' || item === null) return false;
          const obj = item as Record<string, unknown>;
          return obj.identifier && obj.status && typeof obj.watchedAt === 'string';
        }) as WatchedRun[]
      : [];

    const prs = Array.isArray(data.prs)
      ? (data.prs as unknown[]).filter((item: unknown) => {
          if (typeof item !== 'object' || item === null) return false;
          const obj = item as Record<string, unknown>;
          return obj.identifier && typeof obj.watchedAt === 'string' && typeof obj.prState === 'string';
        }) as WatchedPR[]
      : [];

    return { runs, prs };
  }

  /**
   * Save all watches to disk (serialized through write queue).
   */
  async saveAll(runs: WatchedRun[], prs: WatchedPR[]): Promise<void> {
    return this.enqueue(async () => {
      const data: WatchStoreData = { runs, prs };
      await this.writeJson(this.filePath, data);
    });
  }
}
