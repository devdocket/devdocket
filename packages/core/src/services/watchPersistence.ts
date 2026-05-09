import * as vscode from 'vscode';
import { WatchStore } from '../storage/watchStore';
import type { WatchedPR, WatchedRun } from './watcherService';

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
  private persistFailureNotified = false;

  constructor(
    private readonly watchStore: WatchStore,
    private readonly logger: WatcherLogger,
  ) {}

  async loadAll(getPRWatchKey: (pr: WatchedPR) => string): Promise<{ runs: WatchedRun[]; prs: WatchedPR[] }> {
    const data = await this.watchStore.loadAll();
    this.persistedPRWatchKeys = new Set(data.prs.map(getPRWatchKey));
    return data;
  }

  async getPersistedPRWatchKeys(getPRWatchKey: (pr: WatchedPR) => string): Promise<Set<string>> {
    if (!this.persistedPRWatchKeys) {
      const { prs } = await this.watchStore.loadAll();
      this.persistedPRWatchKeys = new Set(prs.map(getPRWatchKey));
    }

    return this.persistedPRWatchKeys;
  }

  rememberPRWatchKey(key: string): void {
    this.persistedPRWatchKeys?.add(key);
  }

  saveAll(runs: WatchedRun[], prs: WatchedPR[]): void {
    this.watchStore.saveAll(runs, prs).then(
      () => {
        if (this.persistFailureNotified) {
          this.persistFailureNotified = false;
          this.logger.info('Watch persistence recovered.');
        }
      },
      err => {
        this.logger.error(`Failed to persist watches: ${err}`);
        if (!this.persistFailureNotified) {
          this.persistFailureNotified = true;
          void vscode.window.showWarningMessage(
            'DevDocket could not save watch state. Watches may be lost when the window reloads.',
          );
        }
      },
    );
  }

  dispose(): void {
    this.persistedPRWatchKeys = undefined;
  }
}
