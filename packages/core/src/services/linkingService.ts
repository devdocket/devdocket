import * as vscode from 'vscode';
import type { DiscoveredItem } from '../api/types';
import type { WorkItem } from '../models/workItem';
import { ItemLinkStore, type ItemLink, type ItemLinkRelation } from '../storage/itemLinkStore';
import { logger } from './logger';
import { ProviderRegistry } from './providerRegistry';
import { WorkGraph } from './workGraph';

function pairKey(itemId1: string, itemId2: string): string {
  return [itemId1, itemId2].sort((a, b) => a.localeCompare(b)).join('::');
}

export class LinkingService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private knownItemIds: Set<string>;
  private reconcileScheduled = false;
  private reconcileInFlight = false;
  private reconcileAgain = false;
  private disposed = false;

  constructor(
    private readonly workGraph: WorkGraph,
    private readonly providerRegistry: ProviderRegistry,
    private readonly linkStore: ItemLinkStore,
  ) {
    this.knownItemIds = new Set(workGraph.getAll().map(item => item.id));
    this.disposables.push(
      providerRegistry.onDidRefreshProvider(() => this.scheduleReconcile()),
      workGraph.onDidChange(() => this.scheduleReconcile()),
    );
    this.scheduleReconcile();
  }

  private scheduleReconcile(): void {
    if (this.disposed || this.reconcileScheduled) {
      return;
    }

    this.reconcileScheduled = true;
    queueMicrotask(() => {
      this.reconcileScheduled = false;
      void this.reconcile().catch(error => {
        logger.error('Failed to reconcile item links', error);
      });
    });
  }

  private async reconcile(): Promise<void> {
    if (this.reconcileInFlight) {
      this.reconcileAgain = true;
      return;
    }

    this.reconcileInFlight = true;
    try {
      await this.removeLinksForDeletedItems();
      await this.reconcileProviderLinks();
    } finally {
      this.reconcileInFlight = false;
      if (this.reconcileAgain) {
        this.reconcileAgain = false;
        this.scheduleReconcile();
      }
    }
  }

  private async removeLinksForDeletedItems(): Promise<void> {
    const currentItemIds = new Set(this.workGraph.getAll().map(item => item.id));
    const deletedItemIds = [...this.knownItemIds].filter(itemId => !currentItemIds.has(itemId));
    this.knownItemIds = currentItemIds;

    for (const deletedItemId of deletedItemIds) {
      const removedLinks = await this.linkStore.removeLinksForItem(deletedItemId);
      for (const link of removedLinks) {
        await this.logLinkActivity('item-unlinked', link, new Set([deletedItemId]));
      }
    }
  }

  private async reconcileProviderLinks(): Promise<void> {
    const expectedLinks = this.buildExpectedProviderLinks();
    const existingProviderLinks = (await this.linkStore.loadAll()).filter(link => link.origin === 'provider');

    for (const expected of expectedLinks.values()) {
      const result = await this.linkStore.upsertLink(expected.itemId1, expected.itemId2, expected.relation, expected.origin);
      if (result.created) {
        await this.logLinkActivity('item-linked', result.link);
      }
    }

    const expectedKeys = new Set(expectedLinks.keys());
    for (const link of existingProviderLinks) {
      if (expectedKeys.has(pairKey(link.itemId1, link.itemId2))) {
        continue;
      }

      const removed = await this.linkStore.deleteLink(link.itemId1, link.itemId2);
      if (removed) {
        await this.logLinkActivity('item-unlinked', removed);
      }
    }
  }

  private buildExpectedProviderLinks(): Map<string, { itemId1: string; itemId2: string; relation: ItemLinkRelation; origin: 'provider' }> {
    const expected = new Map<string, { itemId1: string; itemId2: string; relation: ItemLinkRelation; origin: 'provider' }>();
    const itemsByExternalId = new Map<string, WorkItem[]>();
    for (const item of this.workGraph.getAll()) {
      if (!item.externalId) {
        continue;
      }
      const existing = itemsByExternalId.get(item.externalId) ?? [];
      existing.push(item);
      itemsByExternalId.set(item.externalId, existing);
    }

    for (const [providerId, discoveredItems] of this.providerRegistry.getAllDiscoveredItems()) {
      for (const discoveredItem of discoveredItems) {
        if (!discoveredItem.relatedItems || discoveredItem.relatedItems.length === 0) {
          continue;
        }

        const sourceItems = this.findWorkItemsForDiscovered(providerId, discoveredItem);
        if (sourceItems.length === 0) {
          continue;
        }

        for (const relatedItem of discoveredItem.relatedItems) {
          const targetItems = itemsByExternalId.get(relatedItem.externalId) ?? [];
          for (const sourceItem of sourceItems) {
            for (const targetItem of targetItems) {
              if (sourceItem.id === targetItem.id) {
                continue;
              }

              const key = pairKey(sourceItem.id, targetItem.id);
              const existing = expected.get(key);
              expected.set(key, {
                itemId1: sourceItem.id.localeCompare(targetItem.id) <= 0 ? sourceItem.id : targetItem.id,
                itemId2: sourceItem.id.localeCompare(targetItem.id) <= 0 ? targetItem.id : sourceItem.id,
                relation: existing?.relation === 'closes' || relatedItem.relation === 'closes' ? 'closes' : 'linked',
                origin: 'provider',
              });
            }
          }
        }
      }
    }

    return expected;
  }

  private findWorkItemsForDiscovered(providerId: string, discoveredItem: DiscoveredItem): WorkItem[] {
    return this.workGraph.getAll().filter(item => item.providerId === providerId && item.externalId === discoveredItem.externalId);
  }

  private async logLinkActivity(
    type: 'item-linked' | 'item-unlinked',
    link: ItemLink,
    skipItemIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const entries = [
      { itemId: link.itemId1, otherItemId: link.itemId2 },
      { itemId: link.itemId2, otherItemId: link.itemId1 },
    ].filter(entry => !skipItemIds.has(entry.itemId));

    const results = await Promise.allSettled(entries.map(async ({ itemId, otherItemId }) => {
      const item = this.workGraph.getItem(itemId);
      if (!item) {
        return;
      }
      const otherItem = this.workGraph.getItem(otherItemId);
      const otherLabel = otherItem?.externalId ?? otherItem?.title ?? otherItemId;
      const detail = type === 'item-linked'
        ? `Linked to ${otherLabel}`
        : `Unlinked from ${otherLabel}`;
      await this.workGraph.addActivity(itemId, type, detail);
    }));

    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error(`Failed to record ${type} activity`, result.reason);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
