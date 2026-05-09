import * as vscode from 'vscode';
import type { RunIdentifier, RunStatus, JobStatus, PRIdentifier, PRState } from '@devdocket/shared';
import { WatcherRegistry } from './watcherRegistry';
import { PRWatcherRegistry } from './prWatcherRegistry';
import { RunWatchPool } from './runWatchPool';
import { PRWatchPool } from './prWatchPool';
import { WatchPersistence } from './watchPersistence';
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
  private pollTimer: NodeJS.Timeout | undefined;
  private isPollInFlight = false;
  /**
   * Set to true the moment dispose() runs. All await-resuming code paths
   * inside the polling loops check this and bail out before mutating shared
   * state or calling persistWatches(). Without it, a poll that was awaiting
   * an HTTP call when the user reloaded the window could persist an empty
   * watches list (the maps are cleared synchronously in dispose() before
   * the in-flight poll resumes).
   */
  private disposed = false;
  private configSubscription: vscode.Disposable | undefined;
  private readonly runPool: RunWatchPool;
  private readonly prPool: PRWatchPool;
  private readonly persistence: WatchPersistence;
  private readonly poolSubscriptions: vscode.Disposable[];

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
    watchStore: WatchStore,
    private logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  ) {
    this.persistence = new WatchPersistence(watchStore, logger);
    this.runPool = new RunWatchPool(
      watcherRegistry,
      logger,
      () => this.disposed,
      () => this.ensurePollingActive(),
      (runKey, watch) => this.prPool?.dismissChildlessPRWatchesForRun(runKey, watch) ?? 0,
    );
    this.prPool = new PRWatchPool(
      prWatcherRegistry,
      this.runPool,
      logger,
      () => this.disposed,
      () => this.ensurePollingActive(),
      key => this.persistence.rememberPRWatchKey(key),
    );
    this.poolSubscriptions = [
      this.runPool.onDidDetectJobFailure(event => this._onDidDetectJobFailure.fire(event)),
      this.runPool.onDidCompleteRun(run => this._onDidCompleteRun.fire(run)),
      this.prPool.onDidCompletePR(pr => this._onDidCompletePR.fire(pr)),
    ];

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
    const { runs: watches, prs } = await this.persistence.loadAll(pr => this.getPRWatchKey(pr.identifier));
    const restored = this.runPool.restore(watches);
    const restoredPRs = this.prPool.restore(prs);

    if (restored > 0 || restoredPRs > 0) {
      this.logger.info(`Restored ${restored} run watch(es) and ${restoredPRs} PR watch(es)`);
      this._onDidChangeWatchedRuns.fire(this.getAllWatches());
      if (restoredPRs > 0) {
        this._onDidChangePRWatches.fire();
      }
      if (this.runPool.hasPollableWatches() || this.prPool.hasPollablePRWatches()) {
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
    const result = await this.runPool.startWatch(identifier, parentPRKey);
    if (!result.changed) {
      return result.watch;
    }

    if (!options?.suppressEvents) {
      this._onDidChangeWatchedRuns.fire(this.getAllWatches());
    }

    if (!options?.suppressPersist) {
      this.persistWatches();
    }
    return result.watch;
  }

  /**
   * Start watching a pull request. By default idempotent: if the PR is
   * already being actively watched, returns the existing watch unchanged.
   * If it was previously dismissed, un-dismisses and refreshes its snapshot
   * from scratch.
   *
   * Pass `{ forceRecreate: true }` to wipe any existing watch (and its
   * owned child runs) and recreate from scratch. This is the right choice
   * for explicit user intent (e.g. the manual "Watch URL" command) because
   * the previously-active state may have stale or invisible child runs that
   * the user can't recover any other way.
   *
   * @param identifier - PR identifier from parsePRUrl
   * @returns The watched PR (existing or newly created)
   */
  async startPRWatch(
    identifier: PRIdentifier,
    options?: { forceRecreate?: boolean },
  ): Promise<WatchedPR> {
    const result = await this.prPool.startPRWatch(identifier, options);
    if (!result.changed) {
      return result.watch;
    }

    this._onDidChangePRWatches.fire();
    this._onDidChangeWatchedRuns.fire(this.getAllWatches());
    this.persistWatches();
    return result.watch;
  }

  /**
   * Dismiss a watched run (hides it from the tree).
   */
  dismissWatch(identifier: RunIdentifier): void {
    const result = this.runPool.dismissWatch(identifier);
    if (result.dismissed) {
      if (result.dismissedPRCount > 0) {
        this._onDidChangePRWatches.fire();
      }
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
    const result = this.prPool.dismissPRWatch(identifier);
    if (result.dismissed) {
      this._onDidChangePRWatches.fire();
      this._onDidChangeWatchedRuns.fire(this.getAllWatches());
      this.persistWatches();
    }
  }

  /**
   * Dismiss all completed watches.
   *
   * @returns The number of watches (runs + PRs + child runs of dismissed PRs) marked dismissed.
   */
  dismissAllCompleted(): number {
    const runToPRKeys = this.prPool.buildActiveChildRunIndex();
    const runResult = this.runPool.dismissCompletedRuns(
      (runKey, watch) => this.prPool.getPRKeysForRun(runKey, watch, runToPRKeys),
    );
    const dismissedPRCount = this.prPool.dismissCompletedPRWatches();
    const cascadedPRCount = this.prPool.dismissChildlessPRWatches(runResult.affectedPRKeys);
    const dismissedCount = runResult.dismissedCount + dismissedPRCount + cascadedPRCount;

    if (dismissedCount > 0) {
      this.logger.info(`Dismissed ${dismissedCount} completed watch(es)`);
      this._onDidChangePRWatches.fire();
      this._onDidChangeWatchedRuns.fire(this.getAllWatches());
      this.persistWatches();
    }
    return dismissedCount;
  }

  /**
   * Count how many active watches would be dismissed by {@link dismissAllCompleted}.
   * Used by callers that want to show a confirmation prompt with a meaningful
   * count before invoking the destructive operation.
   */
  countCompletedActiveWatches(): number {
    return this.prPool.countCompletedActiveWatches();
  }

  /**
   * Get all active watches (not dismissed).
   */
  getActiveWatches(): WatchedRun[] {
    return this.runPool.getActiveWatches();
  }

  /**
   * Mark every currently-failed run watch (warning or non-success completion)
   * as acknowledged so the status bar can suppress its warning color until a
   * NEW failure arrives. Fires onDidChangeWatchedRuns so listeners refresh.
   *
   * Acknowledgements are cleared in two places so a re-watched run can alert
   * again: {@link dismissWatch} (drops the ack as the user discards the
   * watch) and the dismissed-then-restarted branch of {@link startWatch}
   * (drops the ack on the deleted key before recreating). PR-level
   * `forceRecreate` also clears acks for owned children. Once a watch is
   * `completed` it isn't polled anymore, so we don't try to clear acks via
   * a polling-driven recovery path — the only realistic way for an
   * acknowledged failure to reappear is via re-watch.
   */
  acknowledgeAllFailures(): void {
    const added = this.runPool.acknowledgeAllFailures();
    if (added > 0) {
      this._onDidChangeWatchedRuns.fire(this.getActiveWatches());
    }
  }

  /**
   * Whether the user has already acknowledged this failure (e.g. by opening
   * the watch panel while the run was in this failed state).
   */
  isFailureAcknowledged(watch: WatchedRun): boolean {
    return this.runPool.isFailureAcknowledged(watch);
  }

  /**
   * Get all active PR watches (not dismissed).
   */
  getActivePRWatches(): WatchedPR[] {
    return this.prPool.getActivePRWatches();
  }

  /**
   * Check whether a PR is currently being actively watched (in memory and
   * not dismissed). In contrast with {@link isPRWatched}, this excludes
   * dismissed entries — useful for distinguishing "already actively watching"
   * from "previously watched and dismissed" in user-facing flows.
   */
  isPRActive(identifier: PRIdentifier): boolean {
    return this.prPool.isPRActive(identifier);
  }

  /**
   * Check whether a run is currently being actively watched (in memory and
   * not dismissed).
   */
  isRunActive(identifier: RunIdentifier): boolean {
    return this.runPool.isRunActive(identifier);
  }

  /**
   * Check whether a PR has ever been watched, including dismissed entries loaded from persisted state on demand.
   */
  async isPRWatched(identifier: PRIdentifier): Promise<boolean> {
    const key = this.getPRWatchKey(identifier);
    if (this.prPool.hasPRWatch(key)) {
      return true;
    }

    return (await this.persistence.getPersistedPRWatchKeys(pr => this.getPRWatchKey(pr.identifier))).has(key);
  }

  /**
   * Get active standalone watches (not dismissed, no parent PR).
   */
  getActiveStandaloneWatches(): WatchedRun[] {
    return this.runPool.getActiveStandaloneWatches(this.prPool.getActiveLinkedRunKeys());
  }

  /**
   * Get active child runs for a PR watch.
   */
  getChildRuns(prKey: string): WatchedRun[] {
    return this.prPool.getChildRuns(prKey);
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
    return this.runPool.getAllWatches();
  }

  /**
   * Get all PR watches including dismissed.
   */
  getAllPRWatches(): WatchedPR[] {
    return this.prPool.getAllPRWatches();
  }

  /**
   * Get a unique key for a PR watch.
   */
  getPRWatchKey(identifier: PRIdentifier): string {
    return this.prPool.getPRWatchKey(identifier);
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
    if (this.isPollInFlight || this.disposed) {
      if (this.isPollInFlight) {
        this.logger.warn('Poll already in flight, skipping tick');
      }
      return;
    }

    this.isPollInFlight = true;
    try {
      const prResult = await this.prPool.pollPRWatches();
      if (this.disposed) return;

      const runChanged = await this.runPool.pollRunWatches();
      if (this.disposed) return;

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

      if (!this.runPool.hasPollableWatches() && !this.prPool.hasPollablePRWatches()) {
        this.stopPolling();
      }
    } finally {
      this.isPollInFlight = false;
    }
  }

  private persistWatches(): void {
    this.persistence.saveAll(this.getAllWatches(), this.getAllPRWatches());
  }

  dispose(): void {
    this.disposed = true;
    this.configSubscription?.dispose();
    this.stopPolling();
    for (const subscription of this.poolSubscriptions) {
      subscription.dispose();
    }
    this._onDidChangeWatchedRuns.dispose();
    this._onDidDetectJobFailure.dispose();
    this._onDidCompleteRun.dispose();
    this._onDidChangePRWatches.dispose();
    this._onDidCompletePR.dispose();
    this.runPool.dispose();
    this.prPool.dispose();
    this.persistence.dispose();
  }
}
