import * as vscode from 'vscode';
import { DevDocketProvider, ProviderItem, type ResolvedItem } from '../api/types';
import { InboxStateStore, InboxState } from '../storage/inboxStateStore';
import { ProviderLabelCache } from '../storage/providerLabelCache';
import { logger } from './logger';
import { WorkItemState } from '../models/workItem';
import { type ActivityType } from '../models/activityLog';

/** Health status of a single provider's most recent refresh attempt. */
export interface ProviderHealthStatus {
  /** Whether the last refresh succeeded or failed. */
  status: 'healthy' | 'unhealthy' | 'unknown';
  /** When the last successful refresh completed. */
  lastRefreshTime?: Date;
  /** Human-readable error message from the last failed refresh, if any. */
  lastError?: string;
}

export type ProviderRefreshOutcome = 'success' | 'failed' | 'timedOut' | 'cancelled';

export interface ProviderRefreshProgress {
  providerId: string;
  providerLabel: string;
  completed: number;
  total: number;
  pendingProviders: Array<{ id: string; label: string }>;
  outcome: ProviderRefreshOutcome;
}

function isActiveWorkItemState(state: WorkItemState | undefined): boolean {
  return state === WorkItemState.New || state === WorkItemState.InProgress || state === WorkItemState.Paused;
}

/**
 * Central registry for {@link DevDocketProvider} instances.
 *
 * Manages provider lifecycle, tracks provider items from each provider,
 * and coordinates inbox state persistence through the {@link InboxStateStore}.
 * Fires events when providers are registered or when their provider items change.
 */
export class ProviderRegistry {
  static readonly REFRESH_TIMEOUT_MS = 30_000;
  /**
   * Maximum number of provider items accepted from a single provider per refresh.
   * Excess items are truncated after logging a warning.
   */
  static readonly MAX_ITEMS_PER_PROVIDER = 10_000;
  private readonly providers = new Map<string, DevDocketProvider>();
  private readonly subscriptions = new Map<string, { dispose(): void }>();
  private readonly providerItems = new Map<string, ProviderItem[]>();
  private readonly _onDidChangeProviderItems = new vscode.EventEmitter<void>();
  /** Fired whenever any provider's provider items change. */
  readonly onDidChangeProviderItems = this._onDidChangeProviderItems.event;
  private readonly _onDidRegisterProvider = new vscode.EventEmitter<void>();
  /** Fired when a new provider is registered. */
  readonly onDidRegisterProvider = this._onDidRegisterProvider.event;
  private readonly _onDidAddNewUnseenItems = new vscode.EventEmitter<number>();
  /** Fired when new unseen items are added to the inbox, with the count of new items. */
  readonly onDidAddNewUnseenItems = this._onDidAddNewUnseenItems.event;
  private readonly _onDidChangeProviderHealth = new vscode.EventEmitter<string>();
  /** Fired when a provider's health info changes (status, lastError, or lastRefreshTime), with the provider ID. */
  readonly onDidChangeProviderHealth = this._onDidChangeProviderHealth.event;
  private readonly _onDidChangeProviderRefreshState = new vscode.EventEmitter<string>();
  /** Fired when a provider starts or stops refreshing, with the provider ID. */
  readonly onDidChangeProviderRefreshState = this._onDidChangeProviderRefreshState.event;
  private readonly _onDidRefreshProvider = new vscode.EventEmitter<string>();
  /**
   * Fired after a provider's provider items have been processed, carrying the
   * provider ID. Listeners can use this to run cross-cutting checks (e.g.
   * auto-complete) against the full WorkGraph rather than just the provider's
   * own provider-items list.
   */
  readonly onDidRefreshProvider = this._onDidRefreshProvider.event;
  /** Previous discovered-item external IDs per provider, for fallback disappearance detection. */
  private readonly previousDiscoveredIds = new Map<string, Set<string>>();
  /** Tracks whether each provider's most recent refresh was truncated. */
  private readonly lastRefreshTruncated = new Map<string, boolean>();
  private readonly healthStatus = new Map<string, ProviderHealthStatus>();
  private readonly _loadingProviders = new Set<string>();
  private readonly _pendingRefreshes = new Map<string, { cts: vscode.CancellationTokenSource; timeoutId: ReturnType<typeof setTimeout> }>();
  /**
   * Per-provider serialization queue for handleProviderItems. A provider that
   * fires onDidDiscoverItems twice in rapid succession would otherwise have two
   * async handlers interleave their reads/writes against the state store and
   * the providerItems map. Chaining each new invocation onto the previous
   * one's promise guarantees ordered, atomic processing per provider.
   */
  private readonly _handleQueues = new Map<string, Promise<void>>();
  private _disposed = false;

  /** Whether any provider is currently performing its initial refresh. */
  get loading(): boolean {
    return this._loadingProviders.size > 0;
  }

  /** Whether at least one provider has been registered. */
  get hasProviders(): boolean {
    return this.providers.size > 0;
  }

  constructor(
    private readonly stateStore: InboxStateStore,
    private readonly labelCache?: ProviderLabelCache,
    private readonly getWorkItemState?: (providerId: string, externalId: string) => WorkItemState | undefined,
    // Kept for constructor compatibility; suppressed version bumps no longer log activity.
    _addActivity?: (providerId: string, externalId: string, type: ActivityType, detail?: string) => Promise<void>,
  ) {}

  /**
   * Register a provider and trigger its initial refresh.
   *
   * The provider's {@link DevDocketProvider.onDidDiscoverItems} event is
   * subscribed to so that future discoveries are automatically tracked.
   *
   * @param provider - The provider to register.
   * @returns A {@link vscode.Disposable} that unregisters the provider when disposed.
   * @throws If a provider with the same {@link DevDocketProvider.id} is already registered.
   */
  register(provider: DevDocketProvider): vscode.Disposable {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }

    this.providers.set(provider.id, provider);
    if (this.labelCache) {
      void this.labelCache.set(provider.id, provider.label).catch(err => {
        logger.debug(`Failed to cache provider label for provider ${provider.id} (label: ${provider.label})`, err);
      });
    }
    if (!this.providerItems.has(provider.id)) {
      this.providerItems.set(provider.id, []);
    }
    logger.info(`Registered provider: ${provider.id} (${provider.label})`);

    const sub = provider.onDidDiscoverItems((items) => {
      // Serialize per-provider so two emissions in rapid succession don't
      // interleave their reads of stateStore / writes to providerItems.
      // When nothing is in flight we invoke synchronously so the handler's
      // sync prefix (setting providerItems, queueing setStates) runs
      // before the listener returns — preserving the contract that callers
      // can observe the updated provider-items map immediately after a
      // synchronous fire-and-forget event emission.
      const tail = this._handleQueues.get(provider.id);
      const startNext = (): Promise<void> =>
        this.handleProviderItems(provider.id, items)
          .catch(err => logger.error('handleProviderItems failed', err));
      const next = tail
        ? tail.catch(() => undefined).then(startNext)
        : startNext();
      const tracked = next.finally(() => {
        // Drop our queue slot if we're still the tail. Skipping this is
        // safe (it just means a stale resolved promise hangs around until
        // the next emission replaces it) but cleaning up keeps the map
        // bounded for providers that only ever emit once.
        if (this._handleQueues.get(provider.id) === tracked) {
          this._handleQueues.delete(provider.id);
        }
      });
      this._handleQueues.set(provider.id, tracked);
    });
    this.subscriptions.set(provider.id, sub);

    this._loadingProviders.add(provider.id);
    this._onDidRegisterProvider.fire();
    this._onDidChangeProviderItems.fire();
    this.refreshWithTimeout(provider)
      .finally(() => {
        this._loadingProviders.delete(provider.id);
        if (!this._disposed) {
          this._onDidChangeProviderItems.fire();
        }
      });

    return new vscode.Disposable(() => {
      this.cancelPendingRefresh(provider.id);
      this.providers.delete(provider.id);
      this.subscriptions.get(provider.id)?.dispose();
      this.subscriptions.delete(provider.id);
      this.providerItems.delete(provider.id);
      this.previousDiscoveredIds.delete(provider.id);
      this.lastRefreshTruncated.delete(provider.id);
      this.healthStatus.delete(provider.id);
      this._loadingProviders.delete(provider.id);
      this._handleQueues.delete(provider.id);
      if (!this._disposed) {
        this._onDidChangeProviderItems.fire();
      }
    });
  }

  /**
   * Look up a registered provider by its unique identifier.
   *
   * @param id - The provider identifier to search for.
   * @returns The matching provider, or `undefined` if not registered.
   */
  getProvider(id: string): DevDocketProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Get all registered providers.
   *
   * @returns An array of all registered providers.
   */
  getProviders(): DevDocketProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get the human-readable label for a provider.
   *
   * @param providerId - The provider identifier.
   * @returns The registered provider's live label if available; otherwise a cached label if one exists; otherwise the raw `providerId`.
   */
  getProviderLabel(providerId: string): string {
    return this.providers.get(providerId)?.label ?? this.labelCache?.get(providerId) ?? providerId;
  }

  /**
   * Get the health status for a provider.
   *
   * @param providerId - The provider identifier.
   * @returns The health status, or a default 'unknown' status if not yet tracked.
   */
  getProviderHealth(providerId: string): ProviderHealthStatus {
    return this.healthStatus.get(providerId) ?? { status: 'unknown' };
  }

  /** Whether a provider refresh is currently in flight. */
  isProviderRefreshing(providerId: string): boolean {
    return this._pendingRefreshes.has(providerId);
  }

  /**
   * Get the provider items for a specific provider.
   *
   * @param providerId - The provider identifier.
   * @returns The array of provider items, or an empty array if the provider has none.
   */
  getProviderItems(providerId: string): ProviderItem[] {
    return this.providerItems.get(providerId) ?? [];
  }

  /**
   * Get all provider items across every registered provider.
   *
   * @returns A map keyed by provider ID, with each value being the provider's provider items.
   */
  getAllProviderItems(): Map<string, ProviderItem[]> {
    return this.providerItems;
  }

  /**
   * Find one live provider item by provider and external id.
   */
  findProviderItem(providerId: string, externalId: string): ProviderItem | undefined {
    return this.getProviderItems(providerId).find(item => item.externalId === externalId);
  }

  /**
   * Check whether an item was in the provider's provider-items list before
   * the most recent refresh. Used as a fallback for auto-complete when the
   * provider does not implement `getClosedItems`.
   */
  wasItemPreviouslyDiscovered(providerId: string, externalId: string): boolean {
    return this.previousDiscoveredIds.get(providerId)?.has(externalId) ?? false;
  }

  /**
   * Whether the most recent refresh for the given provider was truncated due to
   * exceeding {@link MAX_ITEMS_PER_PROVIDER}. When truncated, disappearance-based
   * completion detection is unreliable.
   */
  wasLastRefreshTruncated(providerId: string): boolean {
    return this.lastRefreshTruncated.get(providerId) ?? false;
  }

  /**
   * Ask each registered provider to resolve a URL.
   * Returns the first successful result, or `undefined` if no provider recognizes the URL.
   */
  async resolveUrl(url: string, signal?: AbortSignal): Promise<ResolvedItem | undefined> {
    for (const provider of this.providers.values()) {
      if (typeof provider.resolveUrl !== 'function') { continue; }
      try {
        const result = await provider.resolveUrl(url, signal);
        if (result) { return { ...result, providerId: provider.id }; }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') { throw error; }
        // Provider recognized the URL but failed (e.g. 404, auth error) — surface to user
        logger.warn(`Provider ${provider.id} failed to resolve URL`, error);
        throw error;
      }
    }
    return undefined;
  }

  /**
   * Refresh all registered providers concurrently.
   *
   * Errors from individual providers are logged but do not reject the
   * returned promise, so one failing provider does not block others.
   */
  async refreshAll(
    token?: vscode.CancellationToken,
    onProgress?: (progress: ProviderRefreshProgress) => void,
  ): Promise<void> {
    const providers = Array.from(this.providers.values());
    const completedProviderIds = new Set<string>();
    let completed = 0;

    await Promise.all(providers.map(async (provider) => {
      let outcome: ProviderRefreshOutcome;
      if (token?.isCancellationRequested) {
        outcome = 'cancelled';
      } else {
        logger.debug(`Provider ${provider.id} refreshing...`);
        outcome = await this.refreshWithTimeout(provider, token);
      }

      completedProviderIds.add(provider.id);
      completed++;
      const progressEvent: ProviderRefreshProgress = {
        providerId: provider.id,
        providerLabel: provider.label,
        completed,
        total: providers.length,
        pendingProviders: providers
          .filter(p => !completedProviderIds.has(p.id))
          .map(p => ({ id: p.id, label: p.label })),
        outcome,
      };
      try {
        onProgress?.(progressEvent);
      } catch (err) {
        logger.warn('Provider refresh progress callback failed', err);
      }
    }));
  }

  /** Refresh a single registered provider by ID. */
  async refreshProvider(providerId: string, token?: vscode.CancellationToken): Promise<ProviderRefreshOutcome> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      logger.warn(`Provider not registered: ${providerId}`);
      return 'cancelled';
    }
    if (token?.isCancellationRequested) {
      return 'cancelled';
    }
    logger.debug(`Provider ${provider.id} refreshing...`);
    return this.refreshWithTimeout(provider, token);
  }

  private refreshWithTimeout(provider: DevDocketProvider, parentToken?: vscode.CancellationToken): Promise<ProviderRefreshOutcome> {
    this.cancelPendingRefresh(provider.id);
    const cts = new vscode.CancellationTokenSource();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      if (this.providers.has(provider.id)) {
        logger.warn(`Provider "${provider.id}" refresh timed out after ${ProviderRegistry.REFRESH_TIMEOUT_MS}ms`);
        timedOut = true;
      }
      cts.cancel();
    }, ProviderRegistry.REFRESH_TIMEOUT_MS);
    const parentSub = parentToken?.onCancellationRequested?.(() => cts.cancel());
    if (parentToken?.isCancellationRequested) {
      cts.cancel();
    }
    const entry = { cts, timeoutId };
    this._pendingRefreshes.set(provider.id, entry);
    this._onDidChangeProviderRefreshState.fire(provider.id);

    let providerRefreshPromise: Promise<void>;
    try {
      providerRefreshPromise = Promise.resolve(provider.refresh(cts.token));
    } catch (err) {
      providerRefreshPromise = Promise.reject(err);
    }

    const refreshPromise = providerRefreshPromise
      .then<ProviderRefreshOutcome>(() => {
        if (timedOut) {
          return 'timedOut';
        }
        if (cts.token.isCancellationRequested) {
          return 'cancelled';
        }
        this.updateHealth(provider.id, 'healthy');
        return 'success';
      })
      .catch<ProviderRefreshOutcome>((err: unknown) => {
        if (timedOut) {
          return 'timedOut';
        }
        if (cts.token.isCancellationRequested) {
          logger.debug(`Provider "${provider.id}" refresh cancelled`, err);
          return 'cancelled';
        }
        logger.error(`Provider "${provider.id}" refresh failed`, err);
        const message = err instanceof Error ? err.message : String(err);
        this.updateHealth(provider.id, 'unhealthy', message);
        return 'failed';
      });

    const cancelledPromise = new Promise<ProviderRefreshOutcome>((resolve) => {
      cts.token.onCancellationRequested(() => {
        if (timedOut) {
          this.updateHealth(provider.id, 'unhealthy', 'Refresh timed out');
          resolve('timedOut');
          return;
        }
        resolve('cancelled');
      });
    });

    return Promise.race([refreshPromise, cancelledPromise])
      .finally(() => {
        clearTimeout(timeoutId);
        parentSub?.dispose();
        // Only clean up if this entry is still the current one for this provider
        if (this._pendingRefreshes.get(provider.id) === entry) {
          this._pendingRefreshes.delete(provider.id);
          this._onDidChangeProviderRefreshState.fire(provider.id);
        }
        cts.dispose();
      });
  }

  private cancelPendingRefresh(providerId: string): void {
    const pending = this._pendingRefreshes.get(providerId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pending.cts.cancel();
      // CTS is disposed in refreshWithTimeout's finally block
      this._pendingRefreshes.delete(providerId);
      this._onDidChangeProviderRefreshState.fire(providerId);
    }
  }

  private updateHealth(providerId: string, status: 'healthy' | 'unhealthy', lastError?: string): void {
    if (this._disposed || !this.providers.has(providerId)) {
      return;
    }
    const prev = this.healthStatus.get(providerId);
    const next: ProviderHealthStatus = {
      status,
      lastRefreshTime: status === 'healthy' ? new Date() : prev?.lastRefreshTime,
      lastError: status === 'unhealthy' ? lastError : undefined,
    };
    this.healthStatus.set(providerId, next);
    const prevRefreshTime = prev?.lastRefreshTime?.getTime();
    const nextRefreshTime = next.lastRefreshTime?.getTime();
    if (
      !this._disposed &&
      (prev?.status !== next.status ||
        prev?.lastError !== next.lastError ||
        prevRefreshTime !== nextRefreshTime)
    ) {
      this._onDidChangeProviderHealth.fire(providerId);
    }
  }

  private async handleProviderItems(providerId: string, items: ProviderItem[]): Promise<void> {
    if (this._disposed || !this.providers.has(providerId)) {
      return;
    }
    // Receiving items via onDidDiscoverItems is a "successful refresh" signal.
    // Providers extending BaseProvider drive their own periodic refresh via
    // setInterval, which calls doBackgroundRefresh() directly and bypasses
    // refreshWithTimeout(), so this is the only place we learn about those
    // background successes. Without this, a provider that went unhealthy
    // (e.g. initial-refresh timeout) would never recover until the next
    // user-triggered refreshAll(). updateHealth is a no-op when status is
    // unchanged, so calling it on every emission is cheap.
    //
    // Ordering with refreshWithTimeout: VS Code EventEmitter.fire is
    // synchronous, so a provider that fires items mid-refresh and then
    // throws will see "healthy" set first (here) followed by "unhealthy"
    // set in refreshWithTimeout's .catch(). Net state is correctly
    // unhealthy. The only way an error could be masked is if the provider
    // catches its own errors and only logs them — exactly the anti-pattern
    // that providers.instructions.md warns against.
    this.updateHealth(providerId, 'healthy');
    let wasTruncated = false;
    if (items.length > ProviderRegistry.MAX_ITEMS_PER_PROVIDER) {
      logger.warn(
        `Provider "${providerId}" emitted ${items.length} items, exceeding the limit of ${ProviderRegistry.MAX_ITEMS_PER_PROVIDER}. Truncating.`,
      );
      items = items.slice(0, ProviderRegistry.MAX_ITEMS_PER_PROVIDER);
      wasTruncated = true;
    } else {
      items = items.slice();
    }
    logger.info(`Provider ${providerId} discovered ${items.length} items`);

    // Snapshot previous IDs before replacing, for fallback disappearance detection.
    // Always update — even when prevItems is empty — to avoid stale snapshots from
    // an earlier non-empty refresh persisting across an empty intermediate refresh.
    const prevItems = this.providerItems.get(providerId) ?? [];
    this.previousDiscoveredIds.set(providerId, new Set(prevItems.map(i => i.externalId)));
    this.lastRefreshTruncated.set(providerId, wasTruncated);
    this.providerItems.set(providerId, items);

    const newUnseenUpdates: Array<{ providerId: string; externalId: string; state: 'unseen'; version?: string; resurfaceVersion?: string }> = [];
    const versionBackfills: Array<{ providerId: string; externalId: string; state: InboxState; version?: string; resurfaceVersion?: string }> = [];

    for (const item of items) {
      const existing = this.stateStore.getState(providerId, item.externalId);
      if (existing === undefined) {
        const update: typeof newUnseenUpdates[number] = { providerId, externalId: item.externalId, state: 'unseen' };
        if (item.version !== undefined) { update.version = item.version; }
        if (item.resurfaceVersion !== undefined) { update.resurfaceVersion = item.resurfaceVersion; }
        newUnseenUpdates.push(update);
      } else if (existing === 'accepted' || existing === 'dismissed') {
        let versionTriggered = false;
        let resurfaceVersionTriggered = false;
        let needsAcceptedBackfill = false;
        let needsDismissedResurfaceVersionBackfill = false;

        if (existing === 'accepted' && item.version !== undefined) {
          const storedVersion = this.stateStore.getVersion(providerId, item.externalId);
          if (storedVersion !== undefined && storedVersion !== item.version) {
            versionTriggered = true;
          } else if (storedVersion === undefined) {
            needsAcceptedBackfill = true;
          }
        }

        if (item.resurfaceVersion !== undefined) {
          const storedRV = this.stateStore.getResurfaceVersion(providerId, item.externalId);
          if (storedRV !== undefined && storedRV !== item.resurfaceVersion) {
            resurfaceVersionTriggered = true;
          } else if (storedRV === undefined) {
            if (existing === 'accepted') {
              needsAcceptedBackfill = true;
            } else {
              needsDismissedResurfaceVersionBackfill = true;
            }
          }
        }

        const hasTrigger = versionTriggered || resurfaceVersionTriggered;
        const suppressForActiveWorkItem = hasTrigger && isActiveWorkItemState(this.getWorkItemState?.(providerId, item.externalId));
        const shouldResurface = hasTrigger && !suppressForActiveWorkItem;

        if (shouldResurface) {
          const update: typeof newUnseenUpdates[number] = { providerId, externalId: item.externalId, state: 'unseen' };
          if (item.version !== undefined) { update.version = item.version; }
          if (item.resurfaceVersion !== undefined) { update.resurfaceVersion = item.resurfaceVersion; }
          newUnseenUpdates.push(update);
        } else if (existing === 'accepted' && (suppressForActiveWorkItem || needsAcceptedBackfill)) {
          const update: typeof versionBackfills[number] = { providerId, externalId: item.externalId, state: 'accepted' };
          if (item.version !== undefined) { update.version = item.version; }
          if (item.resurfaceVersion !== undefined) { update.resurfaceVersion = item.resurfaceVersion; }
          versionBackfills.push(update);
        } else if (existing === 'dismissed' && suppressForActiveWorkItem) {
          versionBackfills.push({
            providerId,
            externalId: item.externalId,
            state: 'dismissed',
            resurfaceVersion: item.resurfaceVersion,
          });
        } else if (needsDismissedResurfaceVersionBackfill) {
          versionBackfills.push({
            providerId,
            externalId: item.externalId,
            state: 'dismissed',
            resurfaceVersion: item.resurfaceVersion,
          });
        }
      } else if (existing === 'unseen') {
        if (item.version !== undefined || item.resurfaceVersion !== undefined) {
          const storedVersion = this.stateStore.getVersion(providerId, item.externalId);
          const storedRV = this.stateStore.getResurfaceVersion(providerId, item.externalId);
          const versionChanged = item.version !== undefined && (storedVersion === undefined || storedVersion !== item.version);
          const rvChanged = item.resurfaceVersion !== undefined && (storedRV === undefined || storedRV !== item.resurfaceVersion);
          if (versionChanged || rvChanged) {
            const update: typeof versionBackfills[number] = { providerId, externalId: item.externalId, state: 'unseen' };
            if (item.version !== undefined) { update.version = item.version; }
            if (item.resurfaceVersion !== undefined) { update.resurfaceVersion = item.resurfaceVersion; }
            versionBackfills.push(update);
          }
        }
      }
    }

    const allUpdates = [...newUnseenUpdates, ...versionBackfills];
    if (allUpdates.length > 0) {
      try {
        await this.stateStore.setStates(allUpdates);
        if (!this._disposed && newUnseenUpdates.length > 0) {
          this._onDidAddNewUnseenItems.fire(newUnseenUpdates.length);
        }
      } catch (err) {
        logger.error('Failed to persist inbox states', err);
      }
    }
    if (!this._disposed) {
      this._onDidChangeProviderItems.fire();
      this._onDidRefreshProvider.fire(providerId);
    }
  }

  /** Release all subscriptions and clear internal state. */
  dispose(): void {
    this._disposed = true;
    // Clear providers first so cancellation handlers don't log spurious timeout warnings
    this.providers.clear();
    for (const { cts, timeoutId } of this._pendingRefreshes.values()) {
      clearTimeout(timeoutId);
      cts.cancel();
      // CTS is disposed in refreshWithTimeout's finally block
    }
    this._pendingRefreshes.clear();
    this._handleQueues.clear();
    for (const sub of this.subscriptions.values()) {
      sub.dispose();
    }
    this.subscriptions.clear();
    this._onDidChangeProviderItems.dispose();
    this._onDidRegisterProvider.dispose();
    this._onDidAddNewUnseenItems.dispose();
    this._onDidChangeProviderHealth.dispose();
    this._onDidChangeProviderRefreshState.dispose();
    this._onDidRefreshProvider.dispose();
  }
}
