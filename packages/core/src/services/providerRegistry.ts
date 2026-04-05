import * as vscode from 'vscode';
import { WorkCenterProvider, DiscoveredItem } from '../api/types';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { logger } from './logger';

/**
 * Central registry for {@link WorkCenterProvider} instances.
 *
 * Manages provider lifecycle, tracks discovered items from each provider,
 * and coordinates inbox state persistence through the {@link DiscoveredStateStore}.
 * Fires events when providers are registered or when their discovered items change.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, WorkCenterProvider>();
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
  ) {}

  /**
   * Register a provider and trigger its initial refresh.
   *
   * The provider's {@link WorkCenterProvider.onDidDiscoverItems} event is
   * subscribed to so that future discoveries are automatically tracked.
   *
   * @param provider - The provider to register.
   * @returns A {@link vscode.Disposable} that unregisters the provider when disposed.
   * @throws If a provider with the same {@link WorkCenterProvider.id} is already registered.
   */
  register(provider: WorkCenterProvider): vscode.Disposable {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }

    this.providers.set(provider.id, provider);
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
    provider.refresh()
      .catch((err) => {
        logger.error(`Provider "${provider.id}" refresh failed`, err);
      })
      .finally(() => {
        this._loadingProviders.delete(provider.id);
        this._onDidChangeDiscoveredItems.fire();
      });

    return new vscode.Disposable(() => {
      this.providers.delete(provider.id);
      this.subscriptions.get(provider.id)?.dispose();
      this.subscriptions.delete(provider.id);
      this.discoveredItems.delete(provider.id);
      this._loadingProviders.delete(provider.id);
      this._onDidChangeDiscoveredItems.fire();
    });
  }

  /**
   * Look up a registered provider by its unique identifier.
   *
   * @param id - The provider identifier to search for.
   * @returns The matching provider, or `undefined` if not registered.
   */
  getProvider(id: string): WorkCenterProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Get the human-readable label for a provider.
   *
   * @param providerId - The provider identifier.
   * @returns The provider's label, or the raw `providerId` if the provider is not registered.
   */
  getProviderLabel(providerId: string): string {
    return this.providers.get(providerId)?.label ?? providerId;
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
    const promises = Array.from(this.providers.values()).map((p) => {
      logger.debug(`Provider ${p.id} refreshing...`);
      return p.refresh().catch((err) => {
        logger.error(`Provider "${p.id}" refresh failed`, err);
      });
    });
    await Promise.all(promises);
  }

  private async handleDiscoveredItems(providerId: string, items: DiscoveredItem[]): Promise<void> {
    logger.info(`Provider ${providerId} discovered ${items.length} items`);
    this.discoveredItems.set(providerId, items);
    const provider = this.providers.get(providerId);
    const resurface = provider?.resurfaceDismissed === true;
    const updates: Array<{ providerId: string; externalId: string; state: 'unseen' }> = [];
    for (const item of items) {
      const existing = this.stateStore.getState(providerId, item.externalId);
      if (existing === undefined) {
        updates.push({ providerId, externalId: item.externalId, state: 'unseen' });
      } else if (resurface && existing === 'dismissed') {
        updates.push({ providerId, externalId: item.externalId, state: 'unseen' });
      }
    }
    if (updates.length > 0) {
      try {
        await this.stateStore.setStates(updates);
        this._onDidAddNewUnseenItems.fire(updates.length);
      } catch (err) {
        logger.error('Failed to persist discovered states', err);
      }
    }
    this._onDidChangeDiscoveredItems.fire();
  }

  /** Release all subscriptions and clear internal state. */
  dispose(): void {
    for (const sub of this.subscriptions.values()) {
      sub.dispose();
    }
    this.providers.clear();
    this.subscriptions.clear();
    this._onDidChangeDiscoveredItems.dispose();
    this._onDidRegisterProvider.dispose();
    this._onDidAddNewUnseenItems.dispose();
  }
}
