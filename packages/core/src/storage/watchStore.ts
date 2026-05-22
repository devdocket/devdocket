import type { PRIdentifier } from '@devdocket/shared';
import { logger } from '../services/logger';
import type { FileStore } from './fileStore';
import type { WatchedRun, WatchedPR } from '../services/watcherService';

/**
 * Persisted shape: either a legacy plain array of WatchedRun, or the
 * new envelope with separate `runs` and `prs` arrays.
 */
interface WatchStoreData {
  runs: WatchedRun[];
  prs: WatchedPR[];
}

function getRunKey(run: WatchedRun): string {
  return `${run.identifier.providerId}::${run.identifier.repo}::${run.identifier.runId}`;
}

function getPRKey(pr: WatchedPR): string {
  return `${pr.identifier.providerId}::${pr.identifier.repo}::${pr.identifier.prId}`;
}

/**
 * Persists watched pipeline runs and PR watches in a JSON file under globalStorageUri.
 *
 * Supports the legacy plain-array format (runs only); legacy data is
 * transparently converted on read.
 */
export class WatchStore {
  private lastSeenRunKeys = new Set<string>();
  private lastSeenPRKeys = new Set<string>();

  constructor(private readonly fileStore: FileStore<unknown>) {}

  private async readFromFile(): Promise<WatchStoreData> {
    const parsed = await this.fileStore.read();
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
      logger.warn('Invalid watches data in file store: expected an object or array');
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
   * Load all persisted data from disk.
   * Returns empty arrays if no data exists or data is invalid.
   * Transparently supports the legacy plain-array format (runs only).
   */
  async loadAll(): Promise<WatchStoreData> {
    const data = await this.readFromFile();
    this.lastSeenRunKeys = new Set(data.runs.map(getRunKey));
    this.lastSeenPRKeys = new Set(data.prs.map(getPRKey));
    return data;
  }

  /**
   * Check whether a PR watch exists in persisted state, including dismissed entries.
   */
  async hasPRWatch(identifier: PRIdentifier): Promise<boolean> {
    const { prs } = await this.loadAll();
    return prs.some(pr =>
      pr.identifier.providerId === identifier.providerId
      && pr.identifier.repo === identifier.repo
      && pr.identifier.prId === identifier.prId,
    );
  }

  /**
   * Save all watches to disk while preserving remote-only entries this window
   * has not previously loaded.
   */
  async saveAll(runs: WatchedRun[], prs: WatchedPR[]): Promise<void> {
    const remote = await this.readFromFile();
    const runKeys = new Set(runs.map(getRunKey));
    const prKeys = new Set(prs.map(getPRKey));

    const mergedRuns = new Map(remote.runs.map(run => [getRunKey(run), run]));
    for (const key of this.lastSeenRunKeys) {
      if (!runKeys.has(key)) {
        mergedRuns.delete(key);
      }
    }
    for (const run of runs) {
      mergedRuns.set(getRunKey(run), run);
    }

    const mergedPRs = new Map(remote.prs.map(pr => [getPRKey(pr), pr]));
    for (const key of this.lastSeenPRKeys) {
      if (!prKeys.has(key)) {
        mergedPRs.delete(key);
      }
    }
    for (const pr of prs) {
      mergedPRs.set(getPRKey(pr), pr);
    }

    await this.fileStore.write({
      runs: Array.from(mergedRuns.values()),
      prs: Array.from(mergedPRs.values()),
    });
    this.lastSeenRunKeys = runKeys;
    this.lastSeenPRKeys = prKeys;
  }
}
