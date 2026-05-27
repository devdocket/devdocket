import * as vscode from 'vscode';
import { WatchStore } from '../storage/watchStore';
import type { WatchedPR, WatchedRun } from './watcherService';

interface WatchSnapshot {
  runs: WatchedRun[];
  prs: WatchedPR[];
}

interface PendingWatchSnapshot {
  runs: WatchedRun[];
  prs: WatchedPR[];
}

interface SaveOptions {
  immediate?: boolean;
}

const DEFAULT_DEBOUNCE_MS = 750;

function clonePersistedSnapshot(runs: WatchedRun[], prs: WatchedPR[]): WatchSnapshot {
  // Watch persistence is JSON-backed, so cloning through JSON preserves the queued
  // snapshot without keeping references to later in-memory mutations.
  return JSON.parse(JSON.stringify({ runs, prs })) as WatchSnapshot;
}

function omitLastPolledAt(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitLastPolledAt);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (key !== 'lastPolledAt') {
      result[key] = omitLastPolledAt(childValue);
    }
  }
  return result;
}

function snapshotsEqualIgnoringLastPolledAt(left: WatchSnapshot | undefined, right: WatchSnapshot): boolean {
  if (!left) {
    return false;
  }

  return JSON.stringify(omitLastPolledAt(left)) === JSON.stringify(omitLastPolledAt(right));
}

type WatcherLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

/**
 * Storage adapter for watch state with throttled persistence-failure toasts.
 */
export class WatchPersistence {
  private persistedPRWatchKeys: Set<string> | undefined;
  private readonly pendingPRWatchKeys = new Set<string>();
  private persistFailureNotified = false;
  private pendingSave: Promise<void> = Promise.resolve();
  private pendingSnapshot: PendingWatchSnapshot | undefined;
  private lastPersistedSnapshot: WatchSnapshot | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly watchStore: WatchStore,
    private readonly logger: WatcherLogger,
    private readonly debounceMs = DEFAULT_DEBOUNCE_MS,
  ) {}

  async loadAll(getPRWatchKey: (pr: WatchedPR) => string): Promise<{ runs: WatchedRun[]; prs: WatchedPR[] }> {
    const data = await this.watchStore.loadAll();
    this.persistedPRWatchKeys = new Set([
      ...(this.persistedPRWatchKeys ?? []),
      ...this.pendingPRWatchKeys,
      ...data.prs.map(getPRWatchKey),
    ]);
    this.pendingPRWatchKeys.clear();
    this.lastPersistedSnapshot = clonePersistedSnapshot(data.runs, data.prs);
    return data;
  }

  async getPersistedPRWatchKeys(getPRWatchKey: (pr: WatchedPR) => string): Promise<Set<string>> {
    if (!this.persistedPRWatchKeys) {
      const { prs } = await this.watchStore.loadAll();
      this.persistedPRWatchKeys = new Set([
        ...this.pendingPRWatchKeys,
        ...prs.map(getPRWatchKey),
      ]);
      this.pendingPRWatchKeys.clear();
    }

    return this.persistedPRWatchKeys;
  }

  rememberPRWatchKey(key: string): void {
    if (this.persistedPRWatchKeys) {
      this.persistedPRWatchKeys.add(key);
      return;
    }

    this.pendingPRWatchKeys.add(key);
  }

  saveAll(runs: WatchedRun[], prs: WatchedPR[], options: SaveOptions = {}): Promise<void> | void {
    this.pendingSnapshot = { runs, prs };

    if (options.immediate) {
      return this.flush();
    }

    this.scheduleDebouncedFlush();
  }

  async flush(): Promise<void> {
    this.clearDebounceTimer();

    while (true) {
      const snapshot = this.pendingSnapshot
        ? clonePersistedSnapshot(this.pendingSnapshot.runs, this.pendingSnapshot.prs)
        : undefined;
      this.pendingSnapshot = undefined;

      if (snapshot) {
        this.pendingSave = this.pendingSave
          .catch(() => undefined)
          .then(() => this.persistSnapshot(snapshot))
          .catch(() => undefined);
      }

      const pendingSave = this.pendingSave;
      try {
        await pendingSave;
      } catch {
        // saveAll already surfaced the failure; flushing is best-effort.
      }

      if (!this.pendingSnapshot && pendingSave === this.pendingSave) {
        return;
      }
    }
  }

  private scheduleDebouncedFlush(): void {
    this.clearDebounceTimer();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  private async persistSnapshot(snapshot: WatchSnapshot): Promise<void> {
    if (snapshotsEqualIgnoringLastPolledAt(this.lastPersistedSnapshot, snapshot)) {
      return;
    }

    try {
      await this.watchStore.saveAll(snapshot.runs, snapshot.prs);
      this.lastPersistedSnapshot = snapshot;
      if (this.persistFailureNotified) {
        this.persistFailureNotified = false;
        this.logger.info('Watch persistence recovered.');
      }
    } catch (err) {
      this.logger.error(`Failed to persist watches: ${err}`);
      if (!this.persistFailureNotified) {
        this.persistFailureNotified = true;
        void vscode.window.showWarningMessage(
          'DevDocket could not save watch state. Watches may be lost when the window reloads.',
        );
      }
      throw err;
    }
  }

  dispose(): void {
    void this.flush();
    this.persistedPRWatchKeys = undefined;
    this.pendingPRWatchKeys.clear();
  }
}
