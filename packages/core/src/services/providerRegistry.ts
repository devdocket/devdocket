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
  private readonly _pendingRefreshes = new Map<string, { cts: vscode.CancellationTokenSource; timeoutId: ReturnType<typeof setTimeout> }>();
  private _disposed = false;

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
        if (!this._disposed) {
          this._onDidAddNewUnseenItems.fire(updates.length);
        }
      } catch (err) {
        logger.error('Failed to persist discovered states', err);
      }
    }
    if (!this._disposed) {
      this._onDidChangeDiscoveredItems.fire();
    }
  }

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
