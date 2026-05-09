import * as vscode from 'vscode';
import { DevDocketProvider, ProviderItem, type ResolvedItem } from '../api/types';
import { DiscoveredStateStore, InboxState } from '../storage/discoveredStateStore';
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

function isActiveWorkItemState(state: WorkItemState | undefined): boolean {
  return state === WorkItemState.New || state === WorkItemState.InProgress || state === WorkItemState.Paused;
}

/**
 * Central registry for {@link DevDocketProvider} instances.
 *
 * Manages provider lifecycle, tracks discovered items from each provider,
 * and coordinates inbox state persistence through the {@link DiscoveredStateStore}.
 * Fires events when providers are registered or when their discovered items change.
 */
export class ProviderRegistry {
  static readonly REFRESH_TIMEOUT_MS = 30_000;
  /**
   * Maximum number of discovered items accepted from a single provider per refresh.
   * Excess items are truncated after logging a warning.
   */
  static readonly MAX_ITEMS_PER_PROVIDER = 10_000;
  private readonly providers = new Map<string, DevDocketProvider>();
  private readonly subscriptions = new Map<string, { dispose(): void }>();
  private readonly discoveredItems = new Map<string, ProviderItem[]>();
  private readonly _onDidChangeDiscoveredItems = new vscode.EventEmitter<void>();
  /** Fired whenever any provider's discovered items change. */
  readonly onDidChangeDiscoveredItems = this._onDidChangeDiscoveredItems.event;
  private readonly _onDidRegisterProvider = new vscode.EventEmitter<void>();
  /** Fired when a new provider is registered. */
  readonly onDidRegisterProvider = this._onDidRegisterProvider.event;
  private readonly _onDidAddNewUnseenItems = new vscode.EventEmitter<number>();
  /** Fired when new unseen items are added to the inbox, with the count of new items. */
  readonly onDidAddNewUnseenItems = this._onDidAddNewUnseenItems.event;
  private readonly _onDidChangeProviderHealth = new vscode.EventEmitter<string>();
  /** Fired when a provider's health info changes (status, lastError, or lastRefreshTime), with the provider ID. */
  readonly onDidChangeProviderHealth = this._onDidChangeProviderHealth.event;
  private readonly _onDidRefreshProvider = new vscode.EventEmitter<string>();
  /**
   * Fired after a provider's discovered items have been processed, carrying the
   * provider ID. Listeners can use this to run cross-cutting checks (e.g.
   * auto-complete) against the full WorkGraph rather than just the provider's
   * own discovered-items list.
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
   * Per-provider serialization queue for handleDiscoveredItems. A provider that
   * fires onDidDiscoverItems twice in rapid succession would otherwise have two
   * async handlers interleave their reads/writes against the state store and
   * the discoveredItems map. Chaining each new invocation onto the previous
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
    private readonly stateStore: DiscoveredStateStore,
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
    if (!this.discoveredItems.has(provider.id)) {
      this.discoveredItems.set(provider.id, []);
    }
    logger.info(`Registered provider: ${provider.id} (${provider.label})`);

    const sub = provider.onDidDiscoverItems((items) => {
      // Serialize per-provider so two emissions in rapid succession don't
      // interleave their reads of stateStore / writes to discoveredItems.
      // When nothing is in flight we invoke synchronously so the handler's
      // sync prefix (setting discoveredItems, queueing setStates) runs
      // before the listener returns — preserving the contract that callers
      // can observe the updated discovered-items map immediately after a
      // synchronous fire-and-forget event emission.
      const tail = this._handleQueues.get(provider.id);
      const startNext = (): Promise<void> =>
        this.handleDiscoveredItems(provider.id, items)
          .catch(err => logger.error('handleDiscoveredItems failed', err));
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
    this._onDidChangeDiscoveredItems.fire();
    this.refreshWithTimeout(provider)
      .finally(() => {
        this._loadingProviders.delete(provider.id);
        if (!this._disposed) {
          this._onDidChangeDiscoveredItems.fire();
        }
      });

    return new vscode.Disposable(() => {
      this.cancelPendingRefresh(provider.id);
      this.providers.delete(provider.id);
      this.subscriptions.get(provider.id)?.dispose();
      this.subscriptions.delete(provider.id);
      this.discoveredItems.delete(provider.id);
      this.previousDiscoveredIds.delete(provider.id);
      this.lastRefreshTruncated.delete(provider.id);
      this.healthStatus.delete(provider.id);
      this._loadingProviders.delete(provider.id);
      this._handleQueues.delete(provider.id);
      if (!this._disposed) {
        this._onDidChangeDiscoveredItems.fire();
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

  /**
   * Get the discovered items for a specific provider.
   *
   * @param providerId - The provider identifier.
   * @returns The array of discovered items, or an empty array if the provider has none.
   */
  getDiscoveredItems(providerId: string): ProviderItem[] {
    return this.discoveredItems.get(providerId) ?? [];
  }

  /**
   * Get all discovered items across every registered provider.
   *
   * @returns A map keyed by provider ID, with each value being the provider's discovered items.
   */
  getAllDiscoveredItems(): Map<string, ProviderItem[]> {
    return this.discoveredItems;
  }

  /**
   * Check whether an item was in the provider's discovered-items list before
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
   * Returns the first successful result, or `undefined` if no provider recognises the URL.
   */
  async resolveUrl(url: string, signal?: AbortSignal): Promise<ResolvedItem | undefined> {
    for (const provider of this.providers.values()) {
      if (typeof provider.resolveUrl !== 'function') { continue; }
      try {
        const result = await provider.resolveUrl(url, signal);
        if (result) { return { ...result, providerId: provider.id }; }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') { throw error; }
        // Provider recognised the URL but failed (e.g. 404, auth error) — surface to user
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
  async refreshAll(): Promise<void> {
    const providers = Array.from(this.providers.values());
    const results = await Promise.allSettled(
      providers.map((p) => {
        logger.debug(`Provider ${p.id} refreshing...`);
        return this.refreshWithTimeout(p);
      }),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        logger.error(`Provider "${providers[i].id}" refresh failed`, result.reason);
      }
    }
  }

  private refreshWithTimeout(provider: DevDocketProvider): Promise<void> {
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
    const entry = { cts, timeoutId };
    this._pendingRefreshes.set(provider.id, entry);

    const refreshPromise = provider.refresh(cts.token)
      .then(() => {
        if (!cts.token.isCancellationRequested) {
          this.updateHealth(provider.id, 'healthy');
        }
      })
      .catch((err: unknown) => {
        if (!cts.token.isCancellationRequested) {
          logger.error(`Provider "${provider.id}" refresh failed`, err);
          const message = err instanceof Error ? err.message : String(err);
          this.updateHealth(provider.id, 'unhealthy', message);
        }
      });

    const cancelledPromise = new Promise<void>((resolve) => {
      cts.token.onCancellationRequested(() => {
        if (timedOut) {
          this.updateHealth(provider.id, 'unhealthy', 'Refresh timed out');
        }
        resolve();
      });
    });

    return Promise.race([refreshPromise, cancelledPromise])
      .finally(() => {
        clearTimeout(timeoutId);
        // Only clean up if this entry is still the current one for this provider
        if (this._pendingRefreshes.get(provider.id) === entry) {
          this._pendingRefreshes.delete(provider.id);
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
    }
  }

  private updateHealth(providerId: string, status: 'healthy' | 'unhealthy', lastError?: string): void {
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

  private async handleDiscoveredItems(providerId: string, items: ProviderItem[]): Promise<void> {
    if (this._disposed) {
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
    const prevItems = this.discoveredItems.get(providerId) ?? [];
    this.previousDiscoveredIds.set(providerId, new Set(prevItems.map(i => i.externalId)));
    this.lastRefreshTruncated.set(providerId, wasTruncated);
    this.discoveredItems.set(providerId, items);

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
        logger.error('Failed to persist discovered states', err);
      }
    }
    if (!this._disposed) {
      this._onDidChangeDiscoveredItems.fire();
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
    this._onDidChangeDiscoveredItems.dispose();
    this._onDidRegisterProvider.dispose();
    this._onDidAddNewUnseenItems.dispose();
    this._onDidChangeProviderHealth.dispose();
    this._onDidRefreshProvider.dispose();
  }
}
