import * as vscode from 'vscode';
import { WatchStore } from '../storage/watchStore';
import type { WatchedPR, WatchedRun } from './watcherService';

interface WatchSnapshot {
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

function omitLastPolledAtReplacer(key: string, value: unknown): unknown {
  return key === 'lastPolledAt' ? undefined : value;
}

function serializePersistedSnapshot(snapshot: WatchSnapshot): string {
  return JSON.stringify(snapshot, omitLastPolledAtReplacer);
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
  private pendingSnapshot: WatchSnapshot | undefined;
  private lastPersistedSerialized: string | undefined;
  private queuedPersistCount = 0;
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
    this.lastPersistedSerialized = serializePersistedSnapshot(data);
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
      const pendingSnapshot = this.pendingSnapshot;
      this.pendingSnapshot = undefined;

      if (pendingSnapshot) {
        const serialized = serializePersistedSnapshot(pendingSnapshot);
        if (serialized !== this.lastPersistedSerialized || this.queuedPersistCount > 0) {
          const snapshot = clonePersistedSnapshot(pendingSnapshot.runs, pendingSnapshot.prs);
          this.queuedPersistCount += 1;
          this.pendingSave = this.pendingSave
            .catch(() => undefined)
            .then(() => this.persistSnapshot(snapshot, serialized))
            .catch(() => undefined)
            .finally(() => {
              this.queuedPersistCount -= 1;
            });
        }
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

  private async persistSnapshot(snapshot: WatchSnapshot, serialized: string): Promise<void> {
    if (serialized === this.lastPersistedSerialized) {
      return;
    }

    try {
      await this.watchStore.saveAll(snapshot.runs, snapshot.prs);
      this.lastPersistedSerialized = serialized;
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
