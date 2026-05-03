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
  private persistedPRWatchKeys: Set<string> | undefined;
  private configSubscription: vscode.Disposable | undefined;
  /**
   * Set of run-watch keys whose failure the user has already acknowledged
   * (e.g. by opening the watch panel). Used to suppress the warning color
   * on the status bar once the user has been alerted to a failure.
   * In-memory only; resets on extension reload.
   */
  private acknowledgedFailedRunKeys = new Set<string>();
  
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
  ) {
    this.configSubscription = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('devDocket.watches.pollingIntervalSeconds') && this.pollTimer) {
        this.stopPolling();
        this.ensurePollingActive();
      }
    });
  }

  /**
   * Load persisted watches from disk and resume polling for active ones.
   */
  async loadPersistedWatches(): Promise<void> {
    const { runs: watches, prs } = await this.watchStore.loadAll();
    this.persistedPRWatchKeys = new Set(prs.map(pr => this.getPRWatchKey(pr.identifier)));

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
   * Start watching a pipeline run. Idempotent: if the run is already being
   * actively watched, returns the existing watch unchanged. If it was
   * previously dismissed, un-dismisses and refreshes its status.
   * @param identifier - Run identifier from parseRunUrl
   * @param parentPRKey - Optional key of the parent PR watch
   * @returns The watched run (existing or newly created)
   */
  async startWatch(
    identifier: RunIdentifier,
    parentPRKey?: string,
    options?: { suppressEvents?: boolean; suppressPersist?: boolean },
  ): Promise<WatchedRun> {
    const key = this.getWatchKey(identifier);
    const existing = this.watches.get(key);
    if (existing && !existing.dismissed) {
      // Already actively watching — return existing watch unchanged. This
      // makes the "Watch URL" command idempotent so users don't see a hostile
      // error when they re-add a URL that's already being watched. The PR
      // re-add path also lands here, where we keep ownership unchanged to
      // avoid converting a standalone watch into a PR-owned watch.
      return existing;
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
    
    if (!options?.suppressEvents) {
      this._onDidChangeWatchedRuns.fire(this.getAllWatches());
    }
    
    // Start polling if the watch is pollable (not already completed)
    if (watchedRun.status.overallState !== 'completed') {
      this.ensurePollingActive();
    }
    
    if (!options?.suppressPersist) {
      this.persistWatches();
    }
    return watchedRun;
  }

  /**
   * Start watching a pull request. Idempotent: if the PR is already being
   * actively watched, returns the existing watch unchanged but re-syncs its
   * child runs from a fresh snapshot so that any previously-dismissed runs
   * the upstream still considers active are made visible again. (Without
   * the re-sync, a user who dismissed all of a PR's child runs ends up with
   * an invisible PR ΓÇö the panel filter hides PRs with no visible runs and
   * polling never re-adds dismissed children.) If the PR was previously
   * dismissed, un-dismisses and refreshes its snapshot from scratch.
   * @param identifier - PR identifier from parsePRUrl
   * @returns The watched PR (existing or newly created)
   */
  async startPRWatch(identifier: PRIdentifier): Promise<WatchedPR> {
    const key = this.getPRWatchKey(identifier);
    const existing = this.prWatches.get(key);
    if (existing && !existing.dismissed) {
      // Already actively watching ΓÇö return existing unchanged, but re-sync
      // child runs so dismissed-but-still-upstream runs become visible again.
      await this.resyncPRChildRuns(key, existing);
      return existing;
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
    this.persistedPRWatchKeys?.add(key);
    this.consecutiveFailures.delete(key);
    this.logger.info(`Started watching PR: ${identifier.displayName} (${identifier.providerId})`);

    // Add initial runs as child watches (batched — single event/persist after)
    for (const runId of snapshot.runs) {
      const resolved = this.resolveRunIdentifier(runId);
      await this.addChildRun(key, watchedPR, resolved, {
        suppressEvents: true,
        suppressPersist: true,
      });
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
   * Dismiss a watched PR and its owned child runs.
   * Runs not owned by this PR (standalone or owned by another PR) are
   * unlinked but not dismissed.
   */
  dismissPRWatch(identifier: PRIdentifier): void {
    const key = this.getPRWatchKey(identifier);
    const prWatch = this.prWatches.get(key);
    if (prWatch) {
      prWatch.dismissed = true;
      // Only dismiss child runs actually owned by this PR
      for (const childKey of prWatch.childRunKeys) {
        const childWatch = this.watches.get(childKey);
        if (childWatch && childWatch.parentPRKey === key) {
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
        const key = this.getPRWatchKey(prWatch.identifier);
        prWatch.dismissed = true;
        // Only dismiss child runs actually owned by this PR
        for (const childKey of prWatch.childRunKeys) {
          const childWatch = this.watches.get(childKey);
          if (childWatch && !childWatch.dismissed && childWatch.parentPRKey === key) {
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
   * Mark every currently-failed run watch (warning or non-success completion)
   * as acknowledged so the status bar can suppress its warning color until a
   * NEW failure arrives. Fires onDidChangeWatchedRuns so listeners refresh.
   */
  acknowledgeAllFailures(): void {
    let added = 0;
    for (const [key, watch] of this.watches.entries()) {
      if (!watch.dismissed && WatcherService.isFailedRun(watch) && !this.acknowledgedFailedRunKeys.has(key)) {
        this.acknowledgedFailedRunKeys.add(key);
        added += 1;
      }
    }
    if (added > 0) {
      this._onDidChangeWatchedRuns.fire(this.getActiveWatches());
    }
  }

  /**
   * Whether the user has already acknowledged this failure (e.g. by opening
   * the watch panel while the run was in this failed state).
   */
  isFailureAcknowledged(watch: WatchedRun): boolean {
    return this.acknowledgedFailedRunKeys.has(this.getWatchKey(watch.identifier));
  }

  private static isFailedRun(watch: WatchedRun): boolean {
    if (watch.hasWarning) return true;
    if (watch.status.overallState === 'completed' && watch.status.conclusion !== 'success') return true;
    return false;
  }

  /**
   * Get all active PR watches (not dismissed).
   */
  getActivePRWatches(): WatchedPR[] {
    return Array.from(this.prWatches.values()).filter(pr => !pr.dismissed);
  }

  /**
   * Check whether a PR is currently being actively watched (in memory and
   * not dismissed). In contrast with {@link isPRWatched}, this excludes
   * dismissed entries — useful for distinguishing "already actively watching"
   * from "previously watched and dismissed" in user-facing flows.
   */
  isPRActive(identifier: PRIdentifier): boolean {
    const key = this.getPRWatchKey(identifier);
    const existing = this.prWatches.get(key);
    return existing !== undefined && !existing.dismissed;
  }

  /**
   * Check whether a run is currently being actively watched (in memory and
   * not dismissed).
   */
  isRunActive(identifier: RunIdentifier): boolean {
    const key = this.getWatchKey(identifier);
    const existing = this.watches.get(key);
    return existing !== undefined && !existing.dismissed;
  }

  /**
   * Check whether a PR has ever been watched, including dismissed entries loaded from persisted state on demand.
   */
  async isPRWatched(identifier: PRIdentifier): Promise<boolean> {
    const key = this.getPRWatchKey(identifier);
    if (this.prWatches.has(key)) {
      return true;
    }

    return (await this.getPersistedPRWatchKeys()).has(key);
  }

  /**
   * Get active standalone watches (not dismissed, no parent PR).
   */
  getActiveStandaloneWatches(): WatchedRun[] {
    // Collect run keys linked by any active PR
    const prLinkedKeys = new Set<string>();
    for (const prWatch of this.prWatches.values()) {
      if (!prWatch.dismissed) {
        for (const childKey of prWatch.childRunKeys) {
          prLinkedKeys.add(childKey);
        }
      }
    }
    return Array.from(this.watches.values()).filter(
      w => !w.dismissed && !w.parentPRKey && !prLinkedKeys.has(this.getWatchKey(w.identifier))
    );
  }

  /**
   * Get active child runs for a PR watch.
   */
  getChildRuns(prKey: string): WatchedRun[] {
    const childRuns = new Map<string, WatchedRun>();
    // Include runs tracked via childRunKeys (covers linked standalone watches)
    const prWatch = this.prWatches.get(prKey);
    for (const childRunKey of prWatch?.childRunKeys ?? []) {
      const watch = this.watches.get(childRunKey);
      if (watch && !watch.dismissed) {
        childRuns.set(childRunKey, watch);
      }
    }
    // Also include any runs explicitly parented by this PR
    for (const [watchKey, watch] of this.watches.entries()) {
      if (!watch.dismissed && watch.parentPRKey === prKey) {
        childRuns.set(watchKey, watch);
      }
    }
    return Array.from(childRuns.values());
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
    return `pr:${identifier.providerId}:${identifier.repo}:${identifier.prId}`;
  }

  /**
   * Get polling interval from config (in seconds, min 15).
   */
  private getPollingInterval(): number {
    const config = vscode.workspace.getConfiguration('devDocket.watches');
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
      // Phase 1: Poll PR watches first — may add/remove child runs
      const prResult = await this.pollPRWatches();

      // Phase 2: Poll run watches (including newly added child runs)
      const runChanged = await this.pollRunWatches();

      if (prResult.prChanged) {
        this._onDidChangePRWatches.fire();
      }

      if (runChanged || prResult.childRunChanged) {
        this._onDidChangeWatchedRuns.fire(this.getAllWatches());
      }

      const anyChanged = prResult.prChanged || prResult.childRunChanged || runChanged;
      if (anyChanged) {
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
   * @returns Object indicating whether PR metadata or child runs changed
   */
  private async pollPRWatches(): Promise<{ prChanged: boolean; childRunChanged: boolean }> {
    const activePRs = this.getActivePRWatches().filter(
      pr => pr.prState === 'open' && !pr.hasWarning
    );
    if (activePRs.length === 0) return { prChanged: false, childRunChanged: false };

    let prChanged = false;
    let childRunChanged = false;

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
          prChanged = true;
        }

        // Reset failure count
        this.consecutiveFailures.delete(key);
        prWatch.hasWarning = false;
        prWatch.errorMessage = undefined;

        // Handle new/removed runs
        const currentRunKeys = new Set(prWatch.childRunKeys);
        const newRunKeys = new Set<string>();
        for (const runId of snapshot.runs) {
          const resolved = this.resolveRunIdentifier(runId);
          const runKey = this.getWatchKey(resolved);
          newRunKeys.add(runKey);
          if (!currentRunKeys.has(runKey)) {
            const added = await this.addChildRun(key, prWatch, resolved, {
              suppressEvents: true,
              suppressPersist: true,
            });
            if (added) {
              childRunChanged = true;
            }
          }
        }

        // Remove orphaned child runs (only dismiss runs owned by this PR)
        for (const childKey of currentRunKeys) {
          if (!newRunKeys.has(childKey)) {
            const childWatch = this.watches.get(childKey);
            if (childWatch && !childWatch.dismissed && childWatch.parentPRKey === key) {
              childWatch.dismissed = true;
              childRunChanged = true;
            }
            prWatch.childRunKeys = prWatch.childRunKeys.filter(k => k !== childKey);
          }
        }

        // Check PR state transitions
        if (snapshot.prState !== prWatch.prState) {
          prWatch.prState = snapshot.prState;
          prChanged = true;
          if (snapshot.prState === 'merged' || snapshot.prState === 'closed') {
            this._onDidCompletePR.fire(prWatch);
          }
        }

      } catch (err) {
        const failures = (this.consecutiveFailures.get(key) || 0) + 1;
        this.consecutiveFailures.set(key, failures);

        if (failures >= 3) {
          prWatch.hasWarning = true;
          prWatch.errorMessage = err instanceof Error ? err.message : String(err);
          prChanged = true;
          this.logger.warn(`3 consecutive failures for PR ${prWatch.identifier.displayName}, marking with warning`);
        } else {
          this.logger.warn(`PR poll failed for ${prWatch.identifier.displayName} (attempt ${failures}/3): ${err}`);
        }
      }
    }

    return { prChanged, childRunChanged };
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
   * @returns true if the PR's child run list actually changed
   */
  private async addChildRun(
    prKey: string,
    prWatch: WatchedPR,
    runIdentifier: RunIdentifier,
    options?: { suppressEvents?: boolean; suppressPersist?: boolean },
  ): Promise<boolean> {
    const runKey = this.getWatchKey(runIdentifier);
    try {
      const existing = this.watches.get(runKey);
      if (existing && !existing.dismissed) {
        // Preserve ownership of existing watches. Standalone watches remain
        // standalone even when linked from a PR watch.
        if (!prWatch.childRunKeys.includes(runKey)) {
          prWatch.childRunKeys.push(runKey);
          return true;
        }
        return false;
      }

      await this.startWatch(runIdentifier, prKey, options);
      if (!prWatch.childRunKeys.includes(runKey)) {
        prWatch.childRunKeys.push(runKey);
        return true;
      }
      return false;
    } catch (err) {
      this.logger.warn(`Failed to add child run ${runIdentifier.displayName} for PR ${prWatch.identifier.displayName}: ${err}`);
      return false;
    }
  }

  /**
   * Re-sync a PR watch's child runs from a fresh upstream snapshot. Used by
   * the manual "Watch URL" idempotent path: any runs the upstream still
   * reports but which we have locally as dismissed are un-dismissed, and
   * any runs not yet linked are added. This restores a PR to visibility in
   * the watch panel after the user has dismissed all of its runs (the
   * polling cycle alone won't recover, since dismissed children remain in
   * childRunKeys and are skipped on subsequent polls).
   */
  private async resyncPRChildRuns(prKey: string, prWatch: WatchedPR): Promise<void> {
    const prWatcher = this.prWatcherRegistry.get(prWatch.identifier.providerId);
    if (!prWatcher) {
      return;
    }

    let snapshot;
    try {
      snapshot = await prWatcher.getPRRunsSnapshot(prWatch.identifier);
    } catch (err) {
      this.logger.warn(`Failed to re-sync PR child runs for ${prWatch.identifier.displayName}: ${err}`);
      return;
    }

    let changed = false;
    for (const runId of snapshot.runs) {
      const resolved = this.resolveRunIdentifier(runId);
      const runKey = this.getWatchKey(resolved);
      const existingRun = this.watches.get(runKey);

      if (existingRun?.dismissed) {
        // Un-dismiss in place so the existing status / display name are
        // preserved; the next poll will refresh its status anyway.
        existingRun.dismissed = false;
        changed = true;
      }

      if (!prWatch.childRunKeys.includes(runKey)) {
        const added = await this.addChildRun(prKey, prWatch, resolved, {
          suppressEvents: true,
          suppressPersist: true,
        });
        if (added) {
          changed = true;
        }
      }
    }

    if (changed) {
      this._onDidChangePRWatches.fire();
      this._onDidChangeWatchedRuns.fire(this.getAllWatches());
      this.persistWatches();
      // Resume polling in case it was idle (e.g. all runs were completed
      // and dismissed, so the polling guard considered nothing pollable).
      this.ensurePollingActive();
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

  /**
   * Resolve a run identifier to one backed by a registered watcher.
   * If the identifier's providerId matches a registered watcher directly, returns as-is.
   * Otherwise, tries URL-based matching against all registered run watchers.
   * Returns the resolved identifier, or the original if no resolution is possible.
   */
  private resolveRunIdentifier(identifier: RunIdentifier): RunIdentifier {
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

  private async getPersistedPRWatchKeys(): Promise<Set<string>> {
    if (!this.persistedPRWatchKeys) {
      const { prs } = await this.watchStore.loadAll();
      this.persistedPRWatchKeys = new Set(prs.map(pr => this.getPRWatchKey(pr.identifier)));
    }

    return this.persistedPRWatchKeys;
  }

  private persistWatches(): void {
    this.watchStore.saveAll(this.getAllWatches(), this.getAllPRWatches()).catch(err => {
      this.logger.error(`Failed to persist watches: ${err}`);
    });
  }

  dispose(): void {
    this.configSubscription?.dispose();
    this.stopPolling();
    this._onDidChangeWatchedRuns.dispose();
    this._onDidDetectJobFailure.dispose();
    this._onDidCompleteRun.dispose();
    this._onDidChangePRWatches.dispose();
    this._onDidCompletePR.dispose();
    this.watches.clear();
    this.prWatches.clear();
    this.consecutiveFailures.clear();
    this.persistedPRWatchKeys = undefined;
  }
}
