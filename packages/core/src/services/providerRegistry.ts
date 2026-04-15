import * as vscode from 'vscode';
import { DevDocketProvider, DiscoveredItem } from '../api/types';
import { DiscoveredStateStore, InboxState } from '../storage/discoveredStateStore';
import { ProviderLabelCache } from '../storage/providerLabelCache';
import { logger } from './logger';

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
  private readonly discoveredItems = new Map<string, DiscoveredItem[]>();
  private readonly _onDidChangeDiscoveredItems = new vscode.EventEmitter<void>();
  /** Fired whenever any provider's discovered items change. */
  readonly onDidChangeDiscoveredItems = this._onDidChangeDiscoveredItems.event;
  private readonly _onDidRegisterProvider = new vscode.EventEmitter<void>();
  /** Fired when a new provider is registered. */
  readonly onDidRegisterProvider = this._onDidRegisterProvider.event;
  private readonly _onDidAddNewUnseenItems = new vscode.EventEmitter<number>();
  /** Fired when new unseen items are added to the inbox, with the count of new items. */
  readonly onDidAddNewUnseenItems = this._onDidAddNewUnseenItems.event;
  private readonly _loadingProviders = new Set<string>();
  private readonly _pendingRefreshes = new Map<string, { cts: vscode.CancellationTokenSource; timeoutId: ReturnType<typeof setTimeout> }>();
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
      void this.handleDiscoveredItems(provider.id, items).catch(err => logger.error('handleDiscoveredItems failed', err));
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
      this._loadingProviders.delete(provider.id);
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
   * Get the human-readable label for a provider.
   *
   * @param providerId - The provider identifier.
   * @returns The registered provider's live label if available; otherwise a cached label if one exists; otherwise the raw `providerId`.
   */
  getProviderLabel(providerId: string): string {
    return this.providers.get(providerId)?.label ?? this.labelCache?.get(providerId) ?? providerId;
  }

  /**
   * Get the discovered items for a specific provider.
   *
   * @param providerId - The provider identifier.
   * @returns The array of discovered items, or an empty array if the provider has none.
   */
  getDiscoveredItems(providerId: string): DiscoveredItem[] {
    return this.discoveredItems.get(providerId) ?? [];
  }

  /**
   * Get all discovered items across every registered provider.
   *
   * @returns A map keyed by provider ID, with each value being the provider's discovered items.
   */
  getAllDiscoveredItems(): Map<string, DiscoveredItem[]> {
    return this.discoveredItems;
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
    const timeoutId = setTimeout(() => {
      if (this.providers.has(provider.id)) {
        logger.warn(`Provider "${provider.id}" refresh timed out after ${ProviderRegistry.REFRESH_TIMEOUT_MS}ms`);
      }
      cts.cancel();
    }, ProviderRegistry.REFRESH_TIMEOUT_MS);
    const entry = { cts, timeoutId };
    this._pendingRefreshes.set(provider.id, entry);

    const refreshPromise = provider.refresh(cts.token)
      .catch((err: unknown) => {
        if (!cts.token.isCancellationRequested) {
          logger.error(`Provider "${provider.id}" refresh failed`, err);
        }
      });

    const cancelledPromise = new Promise<void>((resolve) => {
      cts.token.onCancellationRequested(() => resolve());
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

  private async handleDiscoveredItems(providerId: string, items: DiscoveredItem[]): Promise<void> {
    if (this._disposed) {
      return;
    }
    if (items.length > ProviderRegistry.MAX_ITEMS_PER_PROVIDER) {
      logger.warn(
        `Provider "${providerId}" emitted ${items.length} items, exceeding the limit of ${ProviderRegistry.MAX_ITEMS_PER_PROVIDER}. Truncating.`,
      );
      items = items.slice(0, ProviderRegistry.MAX_ITEMS_PER_PROVIDER);
    } else {
      items = items.slice();
    }
    logger.info(`Provider ${providerId} discovered ${items.length} items`);
    this.discoveredItems.set(providerId, items);

    const newUnseenUpdates: Array<{ providerId: string; externalId: string; state: 'unseen'; version?: string }> = [];
    const versionBackfills: Array<{ providerId: string; externalId: string; state: InboxState; version?: string }> = [];

    for (const item of items) {
      const existing = this.stateStore.getState(providerId, item.externalId);
      if (existing === undefined) {
        newUnseenUpdates.push({ providerId, externalId: item.externalId, state: 'unseen', version: item.version });
      } else if (existing === 'accepted' && item.version !== undefined) {
        const storedVersion = this.stateStore.getVersion(providerId, item.externalId);
        if (storedVersion !== undefined && storedVersion !== item.version) {
          // Version changed since last acceptance — resurface in Inbox
          newUnseenUpdates.push({ providerId, externalId: item.externalId, state: 'unseen', version: item.version });
        } else if (storedVersion === undefined) {
          // Backfill version for pre-existing accepted item (no state change)
          versionBackfills.push({ providerId, externalId: item.externalId, state: 'accepted', version: item.version });
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
    for (const sub of this.subscriptions.values()) {
      sub.dispose();
    }
    this.subscriptions.clear();
    this._onDidChangeDiscoveredItems.dispose();
    this._onDidRegisterProvider.dispose();
    this._onDidAddNewUnseenItems.dispose();
  }
}
