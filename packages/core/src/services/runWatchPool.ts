import * as vscode from 'vscode';
import type { JobStatus, RunIdentifier } from '@devdocket/shared';
import { WatcherRegistry } from './watcherRegistry';
import type { WatchedRun } from './watcherService';

type WatcherLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export interface WatchStartResult {
  watch: WatchedRun;
  changed: boolean;
}

export interface DismissWatchResult {
  dismissed: boolean;
  dismissedPRCount: number;
}

export interface DismissCompletedRunsResult {
  dismissedCount: number;
  affectedPRKeys: Set<string>;
}

/**
 * Owns run watch state, polling, failure acknowledgement, and run events.
 */
export class RunWatchPool implements vscode.Disposable {
  private watches = new Map<string, WatchedRun>();
  private consecutiveFailures = new Map<string, number>();
  private acknowledgedFailedRunKeys = new Set<string>();

  private readonly _onDidDetectJobFailure = new vscode.EventEmitter<{ run: WatchedRun; job: JobStatus }>();
  readonly onDidDetectJobFailure = this._onDidDetectJobFailure.event;

  private readonly _onDidCompleteRun = new vscode.EventEmitter<WatchedRun>();
  readonly onDidCompleteRun = this._onDidCompleteRun.event;

  constructor(
    private readonly watcherRegistry: WatcherRegistry,
    private readonly logger: WatcherLogger,
    private readonly isDisposed: () => boolean,
    private readonly onPollingNeeded: () => void,
    private readonly onRunDismissed: (runKey: string, watch: WatchedRun) => number,
  ) {}

  restore(watches: WatchedRun[]): number {
    const restored = watches.filter(w => !w.dismissed);
    for (const watch of restored) {
      this.watches.set(this.getWatchKey(watch.identifier), watch);
    }
    return restored.length;
  }

  async startWatch(identifier: RunIdentifier, parentPRKey?: string): Promise<WatchStartResult> {
    const key = this.getWatchKey(identifier);
    const existing = this.watches.get(key);
    if (existing && !existing.dismissed) {
      return { watch: existing, changed: false };
    }

    if (existing) {
      this.watches.delete(key);
      this.acknowledgedFailedRunKeys.delete(key);
    }

    const watcher = this.watcherRegistry.get(identifier.providerId);
    if (!watcher) {
      throw new Error(`No watcher registered for provider: ${identifier.providerId}`);
    }

    const status = await watcher.getRunStatus(identifier);
    if (status.displayName) {
      identifier.displayName = status.displayName;
    }
    const now = new Date().toISOString();

    const watchedRun: WatchedRun = {
      identifier,
      status,
      watchedAt: now,
      lastPolledAt: now,
      dismissed: false,
      parentPRKey,
    };

    this.watches.set(key, watchedRun);
    this.consecutiveFailures.delete(key);
    this.logger.info(`Started watching: ${identifier.displayName} (${identifier.providerId})`);

    if (watchedRun.status.overallState !== 'completed') {
      this.onPollingNeeded();
    }

    return { watch: watchedRun, changed: true };
  }

  dismissWatch(identifier: RunIdentifier): DismissWatchResult {
    const key = this.getWatchKey(identifier);
    const watch = this.watches.get(key);
    if (!watch) {
      return { dismissed: false, dismissedPRCount: 0 };
    }

    watch.dismissed = true;
    this.acknowledgedFailedRunKeys.delete(key);
    const dismissedPRCount = this.onRunDismissed(key, watch);
    this.logger.info(`Dismissed watch: ${identifier.displayName}`);
    return { dismissed: true, dismissedPRCount };
  }

  deleteOwnedWatch(runKey: string, parentPRKey: string): void {
    const childWatch = this.watches.get(runKey);
    if (childWatch && childWatch.parentPRKey === parentPRKey) {
      this.watches.delete(runKey);
      this.acknowledgedFailedRunKeys.delete(runKey);
    }
  }

  dismissOwnedChildRun(runKey: string, parentPRKey: string, options?: { clearAcknowledgement?: boolean }): boolean {
    const childWatch = this.watches.get(runKey);
    if (childWatch && !childWatch.dismissed && childWatch.parentPRKey === parentPRKey) {
      childWatch.dismissed = true;
      if (options?.clearAcknowledgement !== false) {
        this.acknowledgedFailedRunKeys.delete(runKey);
      }
      return true;
    }
    return false;
  }

  dismissCompletedRuns(getPRKeysForRun: (runKey: string, watch: WatchedRun) => Iterable<string>): DismissCompletedRunsResult {
    let dismissedCount = 0;
    const affectedPRKeys = new Set<string>();

    for (const [key, watch] of this.watches.entries()) {
      if (watch.status.overallState === 'completed' && !watch.dismissed) {
        for (const prKey of getPRKeysForRun(key, watch)) {
          affectedPRKeys.add(prKey);
        }
        watch.dismissed = true;
        this.acknowledgedFailedRunKeys.delete(key);
        dismissedCount++;
      }
    }

    return { dismissedCount, affectedPRKeys };
  }

  acknowledgeAllFailures(): number {
    let added = 0;
    for (const [key, watch] of this.watches.entries()) {
      if (!watch.dismissed && RunWatchPool.isFailedRun(watch) && !this.acknowledgedFailedRunKeys.has(key)) {
        this.acknowledgedFailedRunKeys.add(key);
        added += 1;
      }
    }
    return added;
  }

  isFailureAcknowledged(watch: WatchedRun): boolean {
    return this.acknowledgedFailedRunKeys.has(this.getWatchKey(watch.identifier));
  }

  getActiveWatches(): WatchedRun[] {
    return Array.from(this.watches.values()).filter(w => !w.dismissed);
  }

  getActiveStandaloneWatches(prLinkedKeys: Set<string>): WatchedRun[] {
    return Array.from(this.watches.values()).filter(
      w => !w.dismissed && !w.parentPRKey && !prLinkedKeys.has(this.getWatchKey(w.identifier)),
    );
  }

  getAllWatches(): WatchedRun[] {
    return Array.from(this.watches.values());
  }

  entries(): IterableIterator<[string, WatchedRun]> {
    return this.watches.entries();
  }

  getWatch(runKey: string): WatchedRun | undefined {
    return this.watches.get(runKey);
  }

  isRunActive(identifier: RunIdentifier): boolean {
    const existing = this.watches.get(this.getWatchKey(identifier));
    return existing !== undefined && !existing.dismissed;
  }

  hasPollableWatches(): boolean {
    return this.getActiveWatches().some(w => w.status.overallState !== 'completed' && !w.hasWarning);
  }

  async pollRunWatches(): Promise<boolean> {
    const pollableWatches = this.getActiveWatches().filter(
      w => w.status.overallState !== 'completed' && !w.hasWarning,
    );
    if (pollableWatches.length === 0) return false;

    let anyChanged = false;

    for (const watch of pollableWatches) {
      try {
        const watcher = this.watcherRegistry.get(watch.identifier.providerId);
        if (!watcher) {
          throw new Error(`Watcher '${watch.identifier.providerId}' is no longer registered`);
        }

        const newStatus = await watcher.getRunStatus(watch.identifier);
        const key = this.getWatchKey(watch.identifier);
        if (this.isDisposed()) return anyChanged;
        if (this.watches.get(key) !== watch || watch.dismissed) {
          continue;
        }
        watch.lastPolledAt = new Date().toISOString();

        this.consecutiveFailures.delete(key);
        watch.hasWarning = false;
        watch.errorMessage = undefined;

        const oldStatus = watch.status;
        const statusChanged = oldStatus.overallState !== newStatus.overallState
          || oldStatus.conclusion !== newStatus.conclusion
          || oldStatus.jobs.length !== newStatus.jobs.length
          || newStatus.jobs.some(newJob => {
            const oldJob = newJob.id
              ? oldStatus.jobs.find(j => j.id === newJob.id)
              : oldStatus.jobs.find(j => j.name === newJob.name);
            return !oldJob || oldJob.state !== newJob.state || oldJob.conclusion !== newJob.conclusion;
          });
        watch.status = newStatus;
        if (newStatus.displayName && newStatus.displayName !== watch.identifier.displayName) {
          watch.identifier.displayName = newStatus.displayName;
          anyChanged = true;
        }
        if (statusChanged) {
          anyChanged = true;
        }

        if (newStatus.overallState !== 'completed') {
          for (const newJob of newStatus.jobs) {
            if (newJob.state === 'completed' && newJob.conclusion === 'failure') {
              const oldJob = newJob.id
                ? oldStatus.jobs.find(j => j.id === newJob.id)
                : oldStatus.jobs.find(j => j.name === newJob.name);
              if (!oldJob || oldJob.state !== 'completed' || oldJob.conclusion !== 'failure') {
                this._onDidDetectJobFailure.fire({ run: watch, job: newJob });
              }
            }
          }
        }

        if (oldStatus.overallState !== 'completed' && newStatus.overallState === 'completed') {
          this._onDidCompleteRun.fire(watch);
        }
      } catch (err) {
        const key = this.getWatchKey(watch.identifier);
        const failures = (this.consecutiveFailures.get(key) || 0) + 1;
        this.consecutiveFailures.set(key, failures);

        if (failures >= 3) {
          watch.hasWarning = true;
          watch.errorMessage = err instanceof Error ? err.message : String(err);
          anyChanged = true;
          this.logger.warn(`3 consecutive failures for ${watch.identifier.displayName}, marking with warning`);
        } else {
          this.logger.warn(`Poll failed for ${watch.identifier.displayName} (attempt ${failures}/3): ${err}`);
        }
      }
    }

    return anyChanged;
  }

  getWatchKey(identifier: RunIdentifier): string {
    return identifier.repo
      ? `${identifier.providerId}:${identifier.repo}:${identifier.runId}`
      : `${identifier.providerId}:${identifier.runId}`;
  }

  resolveRunIdentifier(identifier: RunIdentifier): RunIdentifier {
    if (this.watcherRegistry.get(identifier.providerId)) {
      return identifier;
    }

    const watcher = this.watcherRegistry.findWatcherForUrl(identifier.url);
    if (watcher) {
      try {
        const parsed = watcher.parseRunUrl(identifier.url);
        return {
          ...parsed,
          displayName: identifier.displayName || parsed.displayName,
        };
      } catch (err) {
        this.logger.warn(`URL matched watcher '${watcher.id}' but parseRunUrl failed for ${identifier.url}: ${err}`);
      }
    }

    return identifier;
  }

  private static isFailedRun(watch: WatchedRun): boolean {
    if (watch.hasWarning) return true;
    if (watch.status.overallState !== 'completed') return false;
    const conclusion = watch.status.conclusion;
    if (conclusion === undefined || conclusion === 'success') return false;
    if (conclusion === 'cancelled' || conclusion === 'skipped' || conclusion === 'neutral') return false;
    return true;
  }

  dispose(): void {
    this._onDidDetectJobFailure.dispose();
    this._onDidCompleteRun.dispose();
    this.watches.clear();
    this.consecutiveFailures.clear();
    this.acknowledgedFailedRunKeys.clear();
  }
}
