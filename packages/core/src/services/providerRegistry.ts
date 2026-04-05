import * as vscode from 'vscode';
import { WorkCenterProvider, DiscoveredItem } from '../api/types';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { logger } from './logger';

export class ProviderRegistry {
  static readonly REFRESH_TIMEOUT_MS = 30_000;
  private readonly providers = new Map<string, WorkCenterProvider>();
  private readonly subscriptions = new Map<string, { dispose(): void }>();
  private readonly discoveredItems = new Map<string, DiscoveredItem[]>();
  private readonly _onDidChangeDiscoveredItems = new vscode.EventEmitter<void>();
  readonly onDidChangeDiscoveredItems = this._onDidChangeDiscoveredItems.event;
  private readonly _onDidRegisterProvider = new vscode.EventEmitter<void>();
  readonly onDidRegisterProvider = this._onDidRegisterProvider.event;
  private readonly _onDidAddNewUnseenItems = new vscode.EventEmitter<number>();
  readonly onDidAddNewUnseenItems = this._onDidAddNewUnseenItems.event;
  private readonly _loadingProviders = new Set<string>();
  private readonly _pendingCts = new Set<vscode.CancellationTokenSource>();

  get loading(): boolean {
    return this._loadingProviders.size > 0;
  }

  get hasProviders(): boolean {
    return this.providers.size > 0;
  }

  constructor(
    private readonly stateStore: DiscoveredStateStore,
  ) {}

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
    this.refreshWithTimeout(provider)
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

  getProvider(id: string): WorkCenterProvider | undefined {
    return this.providers.get(id);
  }

  getProviderLabel(providerId: string): string {
    return this.providers.get(providerId)?.label ?? providerId;
  }

  getDiscoveredItems(providerId: string): DiscoveredItem[] {
    return this.discoveredItems.get(providerId) ?? [];
  }

  getAllDiscoveredItems(): Map<string, DiscoveredItem[]> {
    return this.discoveredItems;
  }

  async refreshAll(): Promise<void> {
    const promises = Array.from(this.providers.values()).map((p) => {
      logger.debug(`Provider ${p.id} refreshing...`);
      return this.refreshWithTimeout(p);
    });
    await Promise.all(promises);
  }

  private refreshWithTimeout(provider: WorkCenterProvider): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    this._pendingCts.add(cts);
    const timeoutId = setTimeout(() => cts.cancel(), ProviderRegistry.REFRESH_TIMEOUT_MS);
    cts.token.onCancellationRequested(() => {
      if (this.providers.has(provider.id)) {
        logger.warn(`Provider "${provider.id}" refresh timed out after ${ProviderRegistry.REFRESH_TIMEOUT_MS}ms`);
      }
    });

    const refreshPromise = provider.refresh(cts.token)
      .catch((err: unknown) => {
        logger.error(`Provider "${provider.id}" refresh failed`, err);
      });

    const cancelledPromise = new Promise<void>((resolve) => {
      cts.token.onCancellationRequested(() => resolve());
    });

    return Promise.race([refreshPromise, cancelledPromise])
      .finally(() => {
        clearTimeout(timeoutId);
        this._pendingCts.delete(cts);
        cts.dispose();
      });
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

  dispose(): void {
    for (const cts of this._pendingCts) {
      cts.dispose();
    }
    this._pendingCts.clear();
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
