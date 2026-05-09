import * as vscode from 'vscode';
import type { PRIdentifier, RunIdentifier } from '@devdocket/shared';
import { PRWatcherRegistry } from './prWatcherRegistry';
import type { WatchedPR, WatchedRun } from './watcherService';
import type { WatchStartResult } from './runWatchPool';

type WatcherLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export interface RunWatchControl {
  startWatch(identifier: RunIdentifier, parentPRKey?: string): Promise<WatchStartResult>;
  getWatchKey(identifier: RunIdentifier): string;
  getWatch(runKey: string): WatchedRun | undefined;
  getAllWatches(): WatchedRun[];
  entries(): IterableIterator<[string, WatchedRun]>;
  deleteOwnedWatch(runKey: string, parentPRKey: string): void;
  dismissOwnedChildRun(runKey: string, parentPRKey: string, options?: { clearAcknowledgement?: boolean }): boolean;
  resolveRunIdentifier(identifier: RunIdentifier): RunIdentifier;
}

export interface PRWatchStartResult {
  watch: WatchedPR;
  changed: boolean;
}

export interface PRPollResult {
  prChanged: boolean;
  childRunChanged: boolean;
}

export interface DismissPRWatchResult {
  dismissed: boolean;
  childRunChanged: boolean;
}

/**
 * Owns PR watch state, PR polling, and child-run linkage.
 */
export class PRWatchPool implements vscode.Disposable {
  private prWatches = new Map<string, WatchedPR>();
  private consecutiveFailures = new Map<string, number>();

  private readonly _onDidCompletePR = new vscode.EventEmitter<WatchedPR>();
  readonly onDidCompletePR = this._onDidCompletePR.event;

  constructor(
    private readonly prWatcherRegistry: PRWatcherRegistry,
    private readonly runControl: RunWatchControl,
    private readonly logger: WatcherLogger,
    private readonly isDisposed: () => boolean,
    private readonly onPollingNeeded: () => void,
    private readonly rememberPRWatchKey: (key: string) => void,
  ) {}

  restore(prs: WatchedPR[]): number {
    const restored = prs.filter(pr => !pr.dismissed);
    for (const pr of restored) {
      this.prWatches.set(this.getPRWatchKey(pr.identifier), pr);
    }
    return restored.length;
  }

  async startPRWatch(identifier: PRIdentifier, options?: { forceRecreate?: boolean }): Promise<PRWatchStartResult> {
    const key = this.getPRWatchKey(identifier);
    const existing = this.prWatches.get(key);

    if (options?.forceRecreate && existing) {
      for (const childKey of existing.childRunKeys) {
        this.runControl.deleteOwnedWatch(childKey, key);
      }
      this.prWatches.delete(key);
    } else if (existing && !existing.dismissed) {
      return { watch: existing, changed: false };
    } else if (existing) {
      this.prWatches.delete(key);
    }

    const prWatcher = this.prWatcherRegistry.get(identifier.providerId);
    if (!prWatcher) {
      throw new Error(`No PR watcher registered for provider: ${identifier.providerId}`);
    }

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
    this.rememberPRWatchKey(key);
    this.consecutiveFailures.delete(key);
    this.logger.info(`Started watching PR: ${identifier.displayName} (${identifier.providerId})`);

    for (const runId of snapshot.runs) {
      const resolved = this.runControl.resolveRunIdentifier(runId);
      await this.addChildRun(key, watchedPR, resolved);
    }

    if (snapshot.prState === 'open') {
      this.onPollingNeeded();
    }

    return { watch: watchedPR, changed: true };
  }

  dismissPRWatch(identifier: PRIdentifier): DismissPRWatchResult {
    const key = this.getPRWatchKey(identifier);
    const prWatch = this.prWatches.get(key);
    if (!prWatch) {
      return { dismissed: false, childRunChanged: false };
    }

    prWatch.dismissed = true;
    let childRunChanged = false;
    for (const childKey of prWatch.childRunKeys) {
      childRunChanged = this.runControl.dismissOwnedChildRun(childKey, key) || childRunChanged;
    }
    this.logger.info(`Dismissed PR watch: ${identifier.displayName}`);
    return { dismissed: true, childRunChanged };
  }

  dismissCompletedPRWatches(): number {
    let dismissedCount = 0;
    for (const prWatch of this.prWatches.values()) {
      if ((prWatch.prState === 'merged' || prWatch.prState === 'closed') && !prWatch.dismissed) {
        const key = this.getPRWatchKey(prWatch.identifier);
        prWatch.dismissed = true;
        for (const childKey of prWatch.childRunKeys) {
          if (this.runControl.dismissOwnedChildRun(childKey, key)) {
            dismissedCount++;
          }
        }
        dismissedCount++;
      }
    }
    return dismissedCount;
  }

  countCompletedActiveWatches(): number {
    let count = 0;
    const dismissedRunKeys = new Set<string>();
    const dismissedPRKeys = new Set<string>();
    const affectedPRKeys = new Set<string>();
    const runToPRKeys = this.buildActiveChildRunIndex();

    for (const [key, watch] of this.runControl.entries()) {
      if (!watch.dismissed && watch.status.overallState === 'completed') {
        dismissedRunKeys.add(key);
        for (const prKey of this.getPRKeysForRun(key, watch, runToPRKeys)) {
          affectedPRKeys.add(prKey);
        }
        count++;
      }
    }

    for (const [prKey, prWatch] of this.prWatches.entries()) {
      if (!prWatch.dismissed && (prWatch.prState === 'merged' || prWatch.prState === 'closed')) {
        dismissedPRKeys.add(prKey);
        count++;
        for (const childKey of prWatch.childRunKeys) {
          const childWatch = this.runControl.getWatch(childKey);
          if (
            childWatch
            && !childWatch.dismissed
            && childWatch.parentPRKey === prKey
            && !dismissedRunKeys.has(childKey)
          ) {
            dismissedRunKeys.add(childKey);
            count++;
          }
        }
      }
    }

    for (const prKey of affectedPRKeys) {
      if (dismissedPRKeys.has(prKey)) continue;
      const activeChildKeys = this.getActiveChildRunKeys(prKey);
      if (activeChildKeys.length > 0 && activeChildKeys.every(childKey => dismissedRunKeys.has(childKey))) {
        count++;
      }
    }

    return count;
  }

  async pollPRWatches(): Promise<PRPollResult> {
    const activePRs = this.getActivePRWatches().filter(
      pr => pr.prState === 'open' && !pr.hasWarning,
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
        if (this.isDisposed()) return { prChanged, childRunChanged };
        if (this.prWatches.get(key) !== prWatch || prWatch.dismissed) {
          continue;
        }
        prWatch.lastPolledAt = new Date().toISOString();

        if (snapshot.displayName && snapshot.displayName !== prWatch.identifier.displayName) {
          prWatch.identifier.displayName = snapshot.displayName;
          prChanged = true;
        }

        this.consecutiveFailures.delete(key);
        prWatch.hasWarning = false;
        prWatch.errorMessage = undefined;

        const currentRunKeys = new Set(prWatch.childRunKeys);
        const newRunKeys = new Set<string>();
        for (const runId of snapshot.runs) {
          const resolved = this.runControl.resolveRunIdentifier(runId);
          const runKey = this.runControl.getWatchKey(resolved);
          newRunKeys.add(runKey);
          if (!currentRunKeys.has(runKey)) {
            const added = await this.addChildRun(key, prWatch, resolved);
            if (this.isDisposed()) return { prChanged, childRunChanged };
            if (added) {
              childRunChanged = true;
            }
          }
        }

        const hadObservedChildren = currentRunKeys.size > 0 || this.hasObservedChildRun(key, prWatch);
        for (const childKey of currentRunKeys) {
          if (!newRunKeys.has(childKey)) {
            if (this.runControl.dismissOwnedChildRun(childKey, key, { clearAcknowledgement: false })) {
              childRunChanged = true;
            }
            prWatch.childRunKeys = prWatch.childRunKeys.filter(k => k !== childKey);
          }
        }
        if (
          hadObservedChildren
          && this.getActiveChildRunKeys(key).length === 0
          && this.dismissChildlessPRWatches([key], { assumeObserved: true }) > 0
        ) {
          prChanged = true;
          continue;
        }

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

  private async addChildRun(
    prKey: string,
    prWatch: WatchedPR,
    runIdentifier: RunIdentifier,
  ): Promise<boolean> {
    const runKey = this.runControl.getWatchKey(runIdentifier);
    try {
      const existing = this.runControl.getWatch(runKey);
      if (existing && !existing.dismissed) {
        if (!prWatch.childRunKeys.includes(runKey)) {
          prWatch.childRunKeys.push(runKey);
          return true;
        }
        return false;
      }

      await this.runControl.startWatch(runIdentifier, prKey);
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

  dismissChildlessPRWatchesForRun(runKey: string, watch: WatchedRun): number {
    return this.dismissChildlessPRWatches(this.getPRKeysForRun(runKey, watch));
  }

  dismissChildlessPRWatches(prKeys: Iterable<string>, options?: { assumeObserved?: boolean }): number {
    let dismissedCount = 0;
    for (const prKey of prKeys) {
      const prWatch = this.prWatches.get(prKey);
      if (!prWatch || prWatch.dismissed) continue;
      if (!options?.assumeObserved && !this.hasObservedChildRun(prKey, prWatch)) continue;
      if (this.getActiveChildRunKeys(prKey).length > 0) continue;

      prWatch.dismissed = true;
      dismissedCount++;
      this.logger.info(`Dismissed childless PR watch: ${prWatch.identifier.displayName}`);
    }
    return dismissedCount;
  }

  getPRKeysForRun(
    runKey: string,
    watch: WatchedRun,
    runToPRKeys = this.buildActiveChildRunIndex(),
  ): Set<string> {
    const prKeys = new Set<string>();
    if (watch.parentPRKey) {
      prKeys.add(watch.parentPRKey);
    }
    for (const prKey of runToPRKeys.get(runKey) ?? []) {
      prKeys.add(prKey);
    }
    return prKeys;
  }

  getActiveChildRunKeys(prKey: string): string[] {
    const childRuns = new Set<string>();
    const prWatch = this.prWatches.get(prKey);
    for (const childRunKey of prWatch?.childRunKeys ?? []) {
      const watch = this.runControl.getWatch(childRunKey);
      if (watch && !watch.dismissed) {
        childRuns.add(childRunKey);
      }
    }
    for (const [watchKey, watch] of this.runControl.entries()) {
      if (!watch.dismissed && watch.parentPRKey === prKey) {
        childRuns.add(watchKey);
      }
    }
    return Array.from(childRuns.values());
  }

  getChildRuns(prKey: string): WatchedRun[] {
    const childRuns = new Map<string, WatchedRun>();
    for (const childRunKey of this.getActiveChildRunKeys(prKey)) {
      const watch = this.runControl.getWatch(childRunKey);
      if (watch) {
        childRuns.set(childRunKey, watch);
      }
    }
    return Array.from(childRuns.values());
  }

  getActiveLinkedRunKeys(): Set<string> {
    const prLinkedKeys = new Set<string>();
    for (const prWatch of this.prWatches.values()) {
      if (!prWatch.dismissed) {
        for (const childKey of prWatch.childRunKeys) {
          prLinkedKeys.add(childKey);
        }
      }
    }
    return prLinkedKeys;
  }

  getActivePRWatches(): WatchedPR[] {
    return Array.from(this.prWatches.values()).filter(pr => !pr.dismissed);
  }

  getAllPRWatches(): WatchedPR[] {
    return Array.from(this.prWatches.values());
  }

  hasPRWatch(key: string): boolean {
    return this.prWatches.has(key);
  }

  isPRActive(identifier: PRIdentifier): boolean {
    const existing = this.prWatches.get(this.getPRWatchKey(identifier));
    return existing !== undefined && !existing.dismissed;
  }

  hasPollablePRWatches(): boolean {
    return this.getActivePRWatches().some(pr => pr.prState === 'open' && !pr.hasWarning);
  }

  getPRWatchKey(identifier: PRIdentifier): string {
    return `pr:${identifier.providerId}:${identifier.repo}:${identifier.prId}`;
  }

  buildActiveChildRunIndex(): Map<string, Set<string>> {
    const runToPRKeys = new Map<string, Set<string>>();
    for (const [prKey, prWatch] of this.prWatches.entries()) {
      if (prWatch.dismissed) continue;
      for (const childKey of prWatch.childRunKeys) {
        const prKeys = runToPRKeys.get(childKey) ?? new Set<string>();
        prKeys.add(prKey);
        runToPRKeys.set(childKey, prKeys);
      }
    }
    return runToPRKeys;
  }

  private hasObservedChildRun(prKey: string, prWatch: WatchedPR): boolean {
    if (prWatch.childRunKeys.length > 0) {
      return true;
    }
    for (const watch of this.runControl.getAllWatches()) {
      if (watch.parentPRKey === prKey) {
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    this._onDidCompletePR.dispose();
    this.prWatches.clear();
    this.consecutiveFailures.clear();
  }
}
