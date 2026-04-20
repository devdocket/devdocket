import * as vscode from 'vscode';
import type { RunIdentifier, RunStatus, JobStatus } from '@devdocket/shared';
import { WatcherRegistry } from './watcherRegistry';
import { WatchStore } from '../storage/watchStore';

/**
 * A watched pipeline run with its current status.
 */
export interface WatchedRun {
  identifier: RunIdentifier;
  status: RunStatus;
  watchedAt: string; // ISO 8601 timestamp
  lastPolledAt: string; // ISO 8601 timestamp
  dismissed: boolean;
  /** Set to true after 3 consecutive failures */
  hasWarning?: boolean;
  /** Error message from last failed poll */
  errorMessage?: string;
}

/**
 * Service that manages watching pipeline runs.
 * Polls for status changes, detects job failures, and fires events.
 */
export class WatcherService implements vscode.Disposable {
  private watches = new Map<string, WatchedRun>();
  private pollTimer: NodeJS.Timeout | undefined;
  private isPollInFlight = false;
  private consecutiveFailures = new Map<string, number>();
  
  private readonly _onDidChangeWatchedRuns = new vscode.EventEmitter<WatchedRun[]>();
  readonly onDidChangeWatchedRuns = this._onDidChangeWatchedRuns.event;
  
  private readonly _onDidDetectJobFailure = new vscode.EventEmitter<{ run: WatchedRun; job: JobStatus }>();
  readonly onDidDetectJobFailure = this._onDidDetectJobFailure.event;
  
  private readonly _onDidCompleteRun = new vscode.EventEmitter<WatchedRun>();
  readonly onDidCompleteRun = this._onDidCompleteRun.event;

  constructor(
    private watcherRegistry: WatcherRegistry,
    private watchStore: WatchStore,
    private logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  ) {}

  /**
   * Load persisted watches from disk and resume polling for active ones.
   */
  async loadPersistedWatches(): Promise<void> {
    const watches = await this.watchStore.loadAll();
    // Only restore non-dismissed watches
    const restored = watches.filter(w => !w.dismissed);
    for (const watch of restored) {
      const key = this.getWatchKey(watch.identifier);
      this.watches.set(key, watch);
    }
    if (restored.length > 0) {
      this.logger.info(`Restored ${restored.length} persisted watch(es)`);
      this._onDidChangeWatchedRuns.fire(this.getAllWatches());
      // Resume polling for any that are still in progress
      const hasPollable = restored.some(
        w => w.status.overallState !== 'completed' && !w.hasWarning
      );
      if (hasPollable) {
        this.ensurePollingActive();
      }
    }
  }

  /**
   * Start watching a pipeline run.
   * @param identifier - Run identifier from parseRunUrl
   * @returns The newly watched run
   * @throws If run is already being watched or watcher not found
   */
  async startWatch(identifier: RunIdentifier): Promise<WatchedRun> {
    const key = this.getWatchKey(identifier);
    const existing = this.watches.get(key);
    if (existing && !existing.dismissed) {
      throw new Error(`Already watching run: ${existing.identifier.displayName}`);
    }
    // Remove dismissed watch to allow re-watching
    if (existing) {
      this.watches.delete(key);
    }

    const watcher = this.watcherRegistry.get(identifier.providerId);
    if (!watcher) {
      throw new Error(`No watcher registered for provider: ${identifier.providerId}`);
    }

    // Fetch initial status
    const status = await watcher.getRunStatus(identifier);
    // Update display name if the watcher returned one
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
    };

    this.watches.set(key, watchedRun);
    this.consecutiveFailures.delete(key);
    this.logger.info(`Started watching: ${identifier.displayName} (${identifier.providerId})`);
    
    this._onDidChangeWatchedRuns.fire(this.getAllWatches());
    
    // Start polling if the watch is pollable (not already completed)
    if (watchedRun.status.overallState !== 'completed') {
      this.ensurePollingActive();
    }
    
    this.persistWatches();
    return watchedRun;
  }

  /**
   * Dismiss a watched run (hides it from the tree).
   */
  dismissWatch(identifier: RunIdentifier): void {
    const key = this.getWatchKey(identifier);
    const watch = this.watches.get(key);
    if (watch) {
      watch.dismissed = true;
      this.logger.info(`Dismissed watch: ${identifier.displayName}`);
      this._onDidChangeWatchedRuns.fire(this.getAllWatches());
      this.persistWatches();
    }
  }

  /**
   * Dismiss all completed watches.
   */
  dismissAllCompleted(): void {
    let dismissedCount = 0;
    for (const watch of this.watches.values()) {
      if (watch.status.overallState === 'completed' && !watch.dismissed) {
        watch.dismissed = true;
        dismissedCount++;
      }
    }
    if (dismissedCount > 0) {
      this.logger.info(`Dismissed ${dismissedCount} completed watch(es)`);
      this._onDidChangeWatchedRuns.fire(this.getAllWatches());
      this.persistWatches();
    }
  }

  /**
   * Get all active watches (not dismissed).
   */
  getActiveWatches(): WatchedRun[] {
    return Array.from(this.watches.values()).filter(w => !w.dismissed);
  }

  /**
   * Get all watches including dismissed.
   */
  getAllWatches(): WatchedRun[] {
    return Array.from(this.watches.values());
  }

  /**
   * Get polling interval from config (in seconds, min 15).
   */
  private getPollingInterval(): number {
    const config = vscode.workspace.getConfiguration('devdocket.watches');
    const interval = config.get<number>('pollingIntervalSeconds', 30);
    return Math.max(interval, 15);
  }

  /**
   * Start or restart the polling timer.
   */
  private ensurePollingActive(): void {
    if (this.pollTimer) {
      return; // Already active
    }
    
    const intervalSeconds = this.getPollingInterval();
    this.pollTimer = setInterval(() => {
      this.pollAllWatches().catch(err => {
        this.logger.error(`Poll error: ${err}`);
      });
    }, intervalSeconds * 1000);
    
    this.logger.info(`Started polling (interval: ${intervalSeconds}s)`);
  }

  /**
   * Stop the polling timer.
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
      this.logger.info('Stopped polling');
    }
  }

  /**
   * Poll all active watches for status updates.
   */
  private async pollAllWatches(): Promise<void> {
    // Concurrency guard: skip if previous poll still in flight
    if (this.isPollInFlight) {
      this.logger.warn('Poll already in flight, skipping tick');
      return;
    }

    const activeWatches = this.getActiveWatches();
    // Only poll watches that are still in progress and haven't hit the failure threshold.
    // Completed watches stay visible until dismissed; warned watches need manual re-watch.
    const pollableWatches = activeWatches.filter(
      w => w.status.overallState !== 'completed' && !w.hasWarning
    );
    if (pollableWatches.length === 0) {
      this.stopPolling();
      return;
    }

    this.isPollInFlight = true;
    try {
      let anyChanged = false;
      
      for (const watch of pollableWatches) {

        try {
          const watcher = this.watcherRegistry.get(watch.identifier.providerId);
          if (!watcher) {
            throw new Error(`Watcher '${watch.identifier.providerId}' is no longer registered`);
          }

          const newStatus = await watcher.getRunStatus(watch.identifier);
          watch.lastPolledAt = new Date().toISOString();
          
          // Reset failure count on success
          const key = this.getWatchKey(watch.identifier);
          this.consecutiveFailures.delete(key);
          watch.hasWarning = false;
          watch.errorMessage = undefined;

          // Snapshot old status for comparison, then update immediately
          // so event subscribers always see current data.
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
          // Update display name if the watcher returned one
          if (newStatus.displayName && newStatus.displayName !== watch.identifier.displayName) {
            watch.identifier.displayName = newStatus.displayName;
            anyChanged = true;
          }
          if (statusChanged) {
            anyChanged = true;
          }

          // Detect job failures (while run is still in progress)
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

          // Check if run just completed
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

      if (anyChanged) {
        this._onDidChangeWatchedRuns.fire(this.getAllWatches());
        this.persistWatches();
      }

    } finally {
      this.isPollInFlight = false;
    }
  }

  /**
   * Generate a unique key for a watch.
   */
  private getWatchKey(identifier: RunIdentifier): string {
    return identifier.repo
      ? `${identifier.providerId}:${identifier.repo}:${identifier.runId}`
      : `${identifier.providerId}:${identifier.runId}`;
  }

  private persistWatches(): void {
    this.watchStore.saveAll(this.getAllWatches()).catch(err => {
      this.logger.error(`Failed to persist watches: ${err}`);
    });
  }

  dispose(): void {
    this.stopPolling();
    this._onDidChangeWatchedRuns.dispose();
    this._onDidDetectJobFailure.dispose();
    this._onDidCompleteRun.dispose();
    this.watches.clear();
    this.consecutiveFailures.clear();
  }
}
