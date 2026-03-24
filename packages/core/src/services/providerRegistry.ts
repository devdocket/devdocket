import * as vscode from 'vscode';
import { WorkCenterProvider, DiscoveredItem } from '../api/types';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';

export class ProviderRegistry {
  private readonly providers = new Map<string, WorkCenterProvider>();
  private readonly subscriptions = new Map<string, { dispose(): void }>();
  private readonly discoveredItems = new Map<string, DiscoveredItem[]>();
  private readonly _onDidChangeDiscoveredItems = new vscode.EventEmitter<void>();
  readonly onDidChangeDiscoveredItems = this._onDidChangeDiscoveredItems.event;
  private readonly _onDidRegisterProvider = new vscode.EventEmitter<void>();
  readonly onDidRegisterProvider = this._onDidRegisterProvider.event;
  private readonly _loadingProviders = new Set<string>();

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
    this._onDidRegisterProvider.fire();

    const sub = provider.onDidDiscoverItems((items) => {
      void this.handleDiscoveredItems(provider.id, items).catch(err => console.error('WorkCenter: handleDiscoveredItems failed:', err));
    });
    this.subscriptions.set(provider.id, sub);

    this._loadingProviders.add(provider.id);
    this._onDidChangeDiscoveredItems.fire();
    provider.refresh()
      .catch((err) => {
        console.error(`WorkCenter: provider "${provider.id}" refresh failed:`, err);
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
    const promises = Array.from(this.providers.values()).map((p) =>
      p.refresh().catch((err) => {
        console.error(`WorkCenter: provider "${p.id}" refresh failed:`, err);
      }),
    );
    await Promise.all(promises);
  }

  private async handleDiscoveredItems(providerId: string, items: DiscoveredItem[]): Promise<void> {
    this.discoveredItems.set(providerId, items);
    const newItems: Array<{ providerId: string; externalId: string; state: 'unseen' }> = [];
    for (const item of items) {
      const existing = this.stateStore.getState(providerId, item.externalId);
      if (existing === undefined) {
        newItems.push({ providerId, externalId: item.externalId, state: 'unseen' });
      }
    }
    if (newItems.length > 0) {
      await this.stateStore.setStates(newItems).catch((err) => {
        console.error('WorkCenter: failed to persist discovered states:', err);
      });
    }
    this._onDidChangeDiscoveredItems.fire();
  }

  dispose(): void {
    for (const sub of this.subscriptions.values()) {
      sub.dispose();
    }
    this.providers.clear();
    this.subscriptions.clear();
    this._onDidChangeDiscoveredItems.dispose();
    this._onDidRegisterProvider.dispose();
  }
}
