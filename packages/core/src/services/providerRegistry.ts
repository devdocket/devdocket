import * as vscode from 'vscode';
import { WorkCenterProvider, DiscoveredItem } from '../api/types';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from './workGraph';

export class ProviderRegistry {
  private readonly providers = new Map<string, WorkCenterProvider>();
  private readonly subscriptions = new Map<string, { dispose(): void }>();

  constructor(private readonly workGraph: WorkGraph) {}

  register(provider: WorkCenterProvider): vscode.Disposable {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }

    this.providers.set(provider.id, provider);

    const sub = provider.onDidDiscoverItems((items) => {
      this.handleDiscoveredItems(provider.id, items);
    });
    this.subscriptions.set(provider.id, sub);

    // Trigger initial refresh
    provider.refresh().catch((err) => {
      console.error(`WorkCenter: provider "${provider.id}" refresh failed:`, err);
    });

    return new vscode.Disposable(() => {
      this.providers.delete(provider.id);
      this.subscriptions.get(provider.id)?.dispose();
      this.subscriptions.delete(provider.id);
    });
  }

  getProvider(id: string): WorkCenterProvider | undefined {
    return this.providers.get(id);
  }

  async refreshAll(): Promise<void> {
    const promises = Array.from(this.providers.values()).map((p) =>
      p.refresh().catch((err) => {
        console.error(`WorkCenter: provider "${p.id}" refresh failed:`, err);
      }),
    );
    await Promise.all(promises);
  }

  private handleDiscoveredItems(providerId: string, items: DiscoveredItem[]): void {
    for (const discovered of items) {
      const existing = this.findExisting(providerId, discovered.externalId);
      if (existing) {
        // Update title/description if changed, but don't touch state
        this.workGraph.updateItem(existing.id, {
          title: discovered.title,
          description: discovered.description,
        });
      } else {
        this.workGraph.createItem(
          { title: discovered.title, description: discovered.description },
          { providerId, externalId: discovered.externalId, url: discovered.url },
        );
      }
    }
  }

  private findExisting(providerId: string, externalId: string): WorkItem | undefined {
    return this.workGraph
      .getAll()
      .find((item) => item.providerId === providerId && item.externalId === externalId);
  }

  dispose(): void {
    for (const sub of this.subscriptions.values()) {
      sub.dispose();
    }
    this.providers.clear();
    this.subscriptions.clear();
  }
}
