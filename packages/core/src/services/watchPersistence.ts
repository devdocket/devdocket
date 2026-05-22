import * as vscode from 'vscode';
import { WatchStore } from '../storage/watchStore';
import type { WatchedPR, WatchedRun } from './watcherService';

function clonePersistedSnapshot(runs: WatchedRun[], prs: WatchedPR[]): { runs: WatchedRun[]; prs: WatchedPR[] } {
  // Watch persistence is JSON-backed, so cloning through JSON preserves the queued
  // snapshot without keeping references to later in-memory mutations.
  return JSON.parse(JSON.stringify({ runs, prs })) as { runs: WatchedRun[]; prs: WatchedPR[] };
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

  constructor(
    private readonly watchStore: WatchStore,
    private readonly logger: WatcherLogger,
  ) {}

  async loadAll(getPRWatchKey: (pr: WatchedPR) => string): Promise<{ runs: WatchedRun[]; prs: WatchedPR[] }> {
    const data = await this.watchStore.loadAll();
    this.persistedPRWatchKeys = new Set([
      ...(this.persistedPRWatchKeys ?? []),
      ...this.pendingPRWatchKeys,
      ...data.prs.map(getPRWatchKey),
    ]);
    this.pendingPRWatchKeys.clear();
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

  saveAll(runs: WatchedRun[], prs: WatchedPR[]): void {
    const snapshot = clonePersistedSnapshot(runs, prs);
    this.pendingSave = this.pendingSave
      .catch(() => undefined)
      .then(() => this.persistSnapshot(snapshot))
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    while (true) {
      const pendingSave = this.pendingSave;
      try {
        await pendingSave;
      } catch {
        // saveAll already surfaced the failure; flushing is best-effort.
      }
      if (pendingSave === this.pendingSave) {
        return;
      }
    }
  }

  private async persistSnapshot(snapshot: { runs: WatchedRun[]; prs: WatchedPR[] }): Promise<void> {
    try {
      await this.watchStore.saveAll(snapshot.runs, snapshot.prs);
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
    this.persistedPRWatchKeys = undefined;
    this.pendingPRWatchKeys.clear();
  }
}
