import * as vscode from 'vscode';
import type { RunIdentifier, RunStatus, JobStatus, PRIdentifier, PRState } from '@devdocket/shared';
import { WatcherRegistry } from './watcherRegistry';
import { PRWatcherRegistry } from './prWatcherRegistry';
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
  /** Key of the parent PR watch, if this run is a child of a PR watch */
  parentPRKey?: string;
}

/**
 * A watched pull request with its lifecycle state.
 */
export interface WatchedPR {
  identifier: PRIdentifier;
  prState: PRState;
  childRunKeys: string[];
  watchedAt: string; // ISO 8601 timestamp
  lastPolledAt: string; // ISO 8601 timestamp
  dismissed: boolean;
  /** Set to true after 3 consecutive failures */
  hasWarning?: boolean;
  /** Error message from last failed poll */
  errorMessage?: string;
}

/**
 * Service that manages watching pipeline runs and pull requests.
 * Polls for status changes, detects job failures, and fires events.
 */
export class WatcherService implements vscode.Disposable {
  private watches = new Map<string, WatchedRun>();
  private prWatches = new Map<string, WatchedPR>();
  private pollTimer: NodeJS.Timeout | undefined;
  private isPollInFlight = false;
  private consecutiveFailures = new Map<string, number>();
  
  private readonly _onDidChangeWatchedRuns = new vscode.EventEmitter<WatchedRun[]>();
  readonly onDidChangeWatchedRuns = this._onDidChangeWatchedRuns.event;
  
  private readonly _onDidDetectJobFailure = new vscode.EventEmitter<{ run: WatchedRun; job: JobStatus }>();
  readonly onDidDetectJobFailure = this._onDidDetectJobFailure.event;
  
  private readonly _onDidCompleteRun = new vscode.EventEmitter<WatchedRun>();
  readonly onDidCompleteRun = this._onDidCompleteRun.event;

  private readonly _onDidChangePRWatches = new vscode.EventEmitter<void>();
  readonly onDidChangePRWatches = this._onDidChangePRWatches.event;

  private readonly _onDidCompletePR = new vscode.EventEmitter<WatchedPR>();
  readonly onDidCompletePR = this._onDidCompletePR.event;

  constructor(
    private watcherRegistry: WatcherRegistry,
    private prWatcherRegistry: PRWatcherRegistry,
    private watchStore: WatchStore,
    private logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  ) {}

  /**
   * Load persisted watches from disk and resume polling for active ones.
   */
  async loadPersistedWatches(): Promise<void> {
    const { runs: watches, prs } = await this.watchStore.loadAll();
    // Restore non-dismissed run watches
    const restored = watches.filter(w => !w.dismissed);
    for (const watch of restored) {
      const key = this.getWatchKey(watch.identifier);
      this.watches.set(key, watch);
    }

    // Restore non-dismissed PR watches
    const restoredPRs = prs.filter(pr => !pr.dismissed);
    for (const pr of restoredPRs) {
      const key = this.getPRWatchKey(pr.identifier);
      this.prWatches.set(key, pr);
    }

    if (restored.length > 0 || restoredPRs.length > 0) {
      this.logger.info(`Restored ${restored.length} run watch(es) and ${restoredPRs.length} PR watch(es)`);
      this._onDidChangeWatchedRuns.fire(this.getAllWatches());
      if (restoredPRs.length > 0) {
        this._onDidChangePRWatches.fire();
      }
      // Resume polling for any that are still in progress
      const hasPollable = restored.some(
        w => w.status.overallState !== 'completed' && !w.hasWarning
      ) || restoredPRs.some(
        pr => pr.prState === 'open' && !pr.hasWarning
      );
      if (hasPollable) {
        this.ensurePollingActive();
      }
    }
  }

  /**
   * Start watching a pipeline run.
   * @param identifier - Run identifier from parseRunUrl
   * @param parentPRKey - Optional key of the parent PR watch
   * @returns The newly watched run
   * @throws If run is already being watched or watcher not found
   */
  async startWatch(identifier: RunIdentifier, parentPRKey?: string): Promise<WatchedRun> {
    const key = this.getWatchKey(identifier);
    const existing = this.watches.get(key);
    if (existing && !existing.dismissed) {
      // If being re-added by a PR watcher, just update parentPRKey
      if (parentPRKey && !existing.parentPRKey) {
        existing.parentPRKey = parentPRKey;
        return existing;
      }
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
      parentPRKey,
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
   * Start watching a pull request.
   * @param identifier - PR identifier from parsePRUrl
   * @returns The newly watched PR
   * @throws If PR is already being watched
   */
  async startPRWatch(identifier: PRIdentifier): Promise<WatchedPR> {
    const key = this.getPRWatchKey(identifier);
    const existing = this.prWatches.get(key);
    if (existing && !existing.dismissed) {
      throw new Error(`Already watching PR: ${existing.identifier.displayName}`);
    }
    if (existing) {
      this.prWatches.delete(key);
    }

    const prWatcher = this.prWatcherRegistry.get(identifier.providerId);
    if (!prWatcher) {
      throw new Error(`No PR watcher registered for provider: ${identifier.providerId}`);
    }

    // Fetch initial snapshot
    const snapshot = await prWatcher.getPRRunsSnapshot(identifier);
    if (snapshot.displayName) {
      identifier.displayName = snapshot.displayName;
    }
    const now = new Date().toISOString();

    const watchedPR: WatchedPR = {
      identifier,
      prState: snapshot.prState,
      childRunKeys: [],
      watchedAt: now,
      lastPolledAt: now,
      dismissed: false,
    };

    this.prWatches.set(key, watchedPR);
    this.consecutiveFailures.delete(key);
    this.logger.info(`Started watching PR: ${identifier.displayName} (${identifier.providerId})`);

    // Add initial runs as child watches
    for (const runId of snapshot.runs) {
      await this.addChildRun(key, watchedPR, runId);
    }

    this._onDidChangePRWatches.fire();
    this._onDidChangeWatchedRuns.fire(this.getAllWatches());

    if (snapshot.prState === 'open') {
      this.ensurePollingActive();
    }

    this.persistWatches();
    return watchedPR;
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
   * Dismiss a watched PR and all its child runs.
   */
  dismissPRWatch(identifier: PRIdentifier): void {
    const key = this.getPRWatchKey(identifier);
    const prWatch = this.prWatches.get(key);
    if (prWatch) {
      prWatch.dismissed = true;
      // Dismiss all child runs
      for (const childKey of prWatch.childRunKeys) {
        const childWatch = this.watches.get(childKey);
        if (childWatch) {
          childWatch.dismissed = true;
        }
      }
      this.logger.info(`Dismissed PR watch: ${identifier.displayName}`);
      this._onDidChangePRWatches.fire();
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
    for (const prWatch of this.prWatches.values()) {
      if ((prWatch.prState === 'merged' || prWatch.prState === 'closed') && !prWatch.dismissed) {
        prWatch.dismissed = true;
        // Dismiss child runs too
        for (const childKey of prWatch.childRunKeys) {
          const childWatch = this.watches.get(childKey);
          if (childWatch && !childWatch.dismissed) {
            childWatch.dismissed = true;
            dismissedCount++;
          }
        }
        dismissedCount++;
      }
    }
    if (dismissedCount > 0) {
      this.logger.info(`Dismissed ${dismissedCount} completed watch(es)`);
      this._onDidChangePRWatches.fire();
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
   * Get all active PR watches (not dismissed).
   */
  getActivePRWatches(): WatchedPR[] {
    return Array.from(this.prWatches.values()).filter(pr => !pr.dismissed);
  }

  /**
   * Get active standalone watches (not dismissed, no parent PR).
   */
  getActiveStandaloneWatches(): WatchedRun[] {
    return Array.from(this.watches.values()).filter(w => !w.dismissed && !w.parentPRKey);
  }

  /**
   * Get active child runs for a PR watch.
   */
  getChildRuns(prKey: string): WatchedRun[] {
    return Array.from(this.watches.values()).filter(
      w => !w.dismissed && w.parentPRKey === prKey
    );
  }

  /**
   * Get a human-friendly label for a provider by looking up its registered watcher.
   */
  getProviderLabel(providerId: string): string | undefined {
    const watcher = this.watcherRegistry.get(providerId);
    if (watcher) return watcher.label;
    const prWatcher = this.prWatcherRegistry.get(providerId);
    return prWatcher?.label;
  }

  /**
   * Get all watches including dismissed.
   */
  getAllWatches(): WatchedRun[] {
    return Array.from(this.watches.values());
  }

  /**
   * Get all PR watches including dismissed.
   */
  getAllPRWatches(): WatchedPR[] {
    return Array.from(this.prWatches.values());
  }

  /**
   * Get a unique key for a PR watch.
   */
  getPRWatchKey(identifier: PRIdentifier): string {
    return `${identifier.providerId}:${identifier.repo}:${identifier.prId}`;
  }

  /**
   * Get polling interval from config (in seconds, min 15).
   */
  private getPollingInterval(): number {
    const config = vscode.workspace.getConfiguration('devdocket.watches');
    const interval = config.get<number>('pollingIntervalSeconds', 60);
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

    this.isPollInFlight = true;
    try {
      let anyChanged = false;

      // Phase 1: Poll PR watches first — may add/remove child runs
      const prChanged = await this.pollPRWatches();
      anyChanged = anyChanged || prChanged;

      // Phase 2: Poll run watches (including newly added child runs)
      const runChanged = await this.pollRunWatches();
      anyChanged = anyChanged || runChanged;

      if (anyChanged) {
        this._onDidChangeWatchedRuns.fire(this.getAllWatches());
        this.persistWatches();
      }

      // Check if anything is still pollable
      const hasPollableRuns = this.getActiveWatches().some(
        w => w.status.overallState !== 'completed' && !w.hasWarning
      );
      const hasPollablePRs = this.getActivePRWatches().some(
        pr => pr.prState === 'open' && !pr.hasWarning
      );
      if (!hasPollableRuns && !hasPollablePRs) {
        this.stopPolling();
      }
    } finally {
      this.isPollInFlight = false;
    }
  }

  /**
   * Poll PR watches for state changes and run updates.
   */
  private async pollPRWatches(): Promise<boolean> {
    const activePRs = this.getActivePRWatches().filter(
      pr => pr.prState === 'open' && !pr.hasWarning
    );
    if (activePRs.length === 0) return false;

    let anyChanged = false;

    for (const prWatch of activePRs) {
      const key = this.getPRWatchKey(prWatch.identifier);
      try {
        const prWatcher = this.prWatcherRegistry.get(prWatch.identifier.providerId);
        if (!prWatcher) {
          throw new Error(`PR watcher '${prWatch.identifier.providerId}' is no longer registered`);
        }

        const snapshot = await prWatcher.getPRRunsSnapshot(prWatch.identifier);
        prWatch.lastPolledAt = new Date().toISOString();

        // Apply updated display name from snapshot
        if (snapshot.displayName && snapshot.displayName !== prWatch.identifier.displayName) {
          prWatch.identifier.displayName = snapshot.displayName;
          anyChanged = true;
        }

        // Reset failure count
        this.consecutiveFailures.delete(key);
        prWatch.hasWarning = false;
        prWatch.errorMessage = undefined;

        // Handle new/removed runs
        const currentRunKeys = new Set(prWatch.childRunKeys);
        const newRunKeys = new Set<string>();
        for (const runId of snapshot.runs) {
          const runKey = this.getWatchKey(runId);
          newRunKeys.add(runKey);
          if (!currentRunKeys.has(runKey)) {
            // New run discovered
            await this.addChildRun(key, prWatch, runId);
            anyChanged = true;
          }
        }

        // Remove orphaned child runs
        for (const childKey of currentRunKeys) {
          if (!newRunKeys.has(childKey)) {
            const childWatch = this.watches.get(childKey);
            if (childWatch && !childWatch.dismissed) {
              childWatch.dismissed = true;
              anyChanged = true;
            }
            prWatch.childRunKeys = prWatch.childRunKeys.filter(k => k !== childKey);
          }
        }

        // Check PR state transitions
        if (snapshot.prState !== prWatch.prState) {
          prWatch.prState = snapshot.prState;
          anyChanged = true;
          if (snapshot.prState === 'merged' || snapshot.prState === 'closed') {
            this._onDidCompletePR.fire(prWatch);
          }
          this._onDidChangePRWatches.fire();
        }

      } catch (err) {
        const failures = (this.consecutiveFailures.get(key) || 0) + 1;
        this.consecutiveFailures.set(key, failures);

        if (failures >= 3) {
          prWatch.hasWarning = true;
          prWatch.errorMessage = err instanceof Error ? err.message : String(err);
          anyChanged = true;
          this._onDidChangePRWatches.fire();
          this.logger.warn(`3 consecutive failures for PR ${prWatch.identifier.displayName}, marking with warning`);
        } else {
          this.logger.warn(`PR poll failed for ${prWatch.identifier.displayName} (attempt ${failures}/3): ${err}`);
        }
      }
    }

    return anyChanged;
  }

  /**
   * Poll run watches for status updates.
   */
  private async pollRunWatches(): Promise<boolean> {
    const activeWatches = this.getActiveWatches();
    const pollableWatches = activeWatches.filter(
      w => w.status.overallState !== 'completed' && !w.hasWarning
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

    return anyChanged;
  }

  /**
   * Add a child run to a PR watch, starting a new watch for it.
   */
  private async addChildRun(prKey: string, prWatch: WatchedPR, runIdentifier: RunIdentifier): Promise<void> {
    const runKey = this.getWatchKey(runIdentifier);
    try {
      const existing = this.watches.get(runKey);
      if (existing && !existing.dismissed) {
        // Already watched as standalone or by another PR — don't re-parent
        if (existing.parentPRKey === prKey) {
          if (!prWatch.childRunKeys.includes(runKey)) {
            prWatch.childRunKeys.push(runKey);
          }
        }
        return;
      }

      await this.startWatch(runIdentifier, prKey);
      if (!prWatch.childRunKeys.includes(runKey)) {
        prWatch.childRunKeys.push(runKey);
      }
    } catch (err) {
      this.logger.warn(`Failed to add child run ${runIdentifier.displayName} for PR ${prWatch.identifier.displayName}: ${err}`);
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
    this.watchStore.saveAll(this.getAllWatches(), this.getAllPRWatches()).catch(err => {
      this.logger.error(`Failed to persist watches: ${err}`);
    });
  }

  dispose(): void {
    this.stopPolling();
    this._onDidChangeWatchedRuns.dispose();
    this._onDidDetectJobFailure.dispose();
    this._onDidCompleteRun.dispose();
    this._onDidChangePRWatches.dispose();
    this._onDidCompletePR.dispose();
    this.watches.clear();
    this.prWatches.clear();
    this.consecutiveFailures.clear();
  }
}
