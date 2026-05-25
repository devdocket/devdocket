import type { PRIdentifier } from '@devdocket/shared';
import { logger } from '../services/logger';
import type { WatchedPR, WatchedRun } from '../services/watcherService';
import type { FileStore } from './fileStore';
import { trimByAge } from './trimByAge';

/**
 * Persisted shape: either a legacy plain array of WatchedRun, or the
 * new envelope with separate `runs` and `prs` arrays.
 */
interface WatchStoreData {
  runs: WatchedRun[];
  prs: WatchedPR[];
}

// 1,000 per watch type is far above typical manual watch usage, but still keeps
// pathological accumulation bounded without evicting active watches.
const MAX_WATCHED_RUNS = 1_000;
const MAX_WATCHED_PRS = 1_000;

function getRunKey(run: WatchedRun): string {
  return `${run.identifier.providerId}::${run.identifier.repo}::${run.identifier.runId}`;
}

function getPRKey(pr: WatchedPR): string {
  return `${pr.identifier.providerId}::${pr.identifier.repo}::${pr.identifier.prId}`;
}

function getWatchedAtTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isActiveRun(run: WatchedRun): boolean {
  return run.status.overallState !== 'completed';
}

function isActivePR(pr: WatchedPR): boolean {
  return pr.prState === 'open';
}

function isWatchedRun(value: unknown): value is WatchedRun {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return obj.identifier !== undefined && obj.status !== undefined;
}

function isWatchedPR(value: unknown): value is WatchedPR {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return obj.identifier !== undefined && typeof obj.prState === 'string';
}

function trimWatchStoreData(data: WatchStoreData): WatchStoreData {
  return {
    runs: trimByAge(data.runs, {
      maxEntries: MAX_WATCHED_RUNS,
      getTimestamp: run => getWatchedAtTimestamp((run as Partial<WatchedRun>).watchedAt),
      getKey: getRunKey,
      isProtected: isActiveRun,
    }),
    prs: trimByAge(data.prs, {
      maxEntries: MAX_WATCHED_PRS,
      getTimestamp: pr => getWatchedAtTimestamp((pr as Partial<WatchedPR>).watchedAt),
      getKey: getPRKey,
      isProtected: isActivePR,
    }),
  };
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
      return {
        runs: parsed.filter(isWatchedRun),
        prs: [],
      };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      logger.warn('Invalid watches data in file store: expected an object or array');
      return { runs: [], prs: [] };
    }

    const data = parsed as Record<string, unknown>;
    const runs = Array.isArray(data.runs)
      ? (data.runs as unknown[]).filter(isWatchedRun)
      : [];

    const prs = Array.isArray(data.prs)
      ? (data.prs as unknown[]).filter(isWatchedPR)
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
    const trimmedData = trimWatchStoreData(data);
    const droppedRuns = data.runs.length - trimmedData.runs.length;
    const droppedPRs = data.prs.length - trimmedData.prs.length;

    if (droppedRuns > 0 || droppedPRs > 0) {
      try {
        await this.fileStore.write(trimmedData);
        logger.warn(
          `Trimmed watches.json while loading to enforce caps: dropped ${droppedRuns} run watch(es) and ${droppedPRs} PR watch(es); caps are ${MAX_WATCHED_RUNS} runs and ${MAX_WATCHED_PRS} PRs`,
        );
      } catch (err) {
        logger.warn(
          `Failed to persist trimmed watches while loading; continuing with ${trimmedData.runs.length} run watch(es) and ${trimmedData.prs.length} PR watch(es) in memory`,
          err,
        );
      }
    }

    this.lastSeenRunKeys = new Set(trimmedData.runs.map(getRunKey));
    this.lastSeenPRKeys = new Set(trimmedData.prs.map(getPRKey));
    return trimmedData;
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

    const trimmedData = trimWatchStoreData({
      runs: Array.from(mergedRuns.values()),
      prs: Array.from(mergedPRs.values()),
    });

    await this.fileStore.write(trimmedData);
    this.lastSeenRunKeys = new Set(trimmedData.runs.map(getRunKey));
    this.lastSeenPRKeys = new Set(trimmedData.prs.map(getPRKey));
  }
}
