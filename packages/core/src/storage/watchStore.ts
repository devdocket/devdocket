import type { Memento } from 'vscode';
import { logger } from '../services/logger';
import type { WatchedRun, WatchedPR } from '../services/watcherService';

const STORAGE_KEY = 'devdocket.watches';

/**
 * On-disk shape: either a legacy plain array of WatchedRun, or the
 * new envelope with separate `runs` and `prs` arrays.
 */
interface WatchStoreData {
  runs: WatchedRun[];
  prs: WatchedPR[];
}

/**
 * Persists watched pipeline runs and PR watches in VS Code globalState.
 *
 * Supports the legacy plain-array format (runs only); legacy data is
 * transparently converted on read.
 */
export class WatchStore {
  private readonly globalState: Memento;

  constructor(globalState: Memento) {
    this.globalState = globalState;
  }

  /**
   * Load all persisted data from globalState.
   * Returns empty arrays if no data exists or data is invalid.
   * Transparently supports the legacy plain-array format (runs only).
   */
  async loadAll(): Promise<WatchStoreData> {
    const parsed = this.globalState.get<unknown>(STORAGE_KEY);
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
      logger.warn('Invalid watches data in globalState: expected an object or array');
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
   * Save all watches to globalState.
   */
  async saveAll(runs: WatchedRun[], prs: WatchedPR[]): Promise<void> {
    const data: WatchStoreData = { runs, prs };
    await this.globalState.update(STORAGE_KEY, data);
  }
}
