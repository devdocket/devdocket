import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import type { ItemLinkStore } from '../storage/itemLinkStore';
import { buildLinkDescription, sortLinkedNodes } from './linkDisplay';
import {
  WorkItemElement, WorkItemViewProvider, isLinkedWorkItemNode,
} from './viewLayout';
import { buildWorkItemTooltip, getWorkItemIcon } from './viewUtils';

export type HistoryElement = WorkItemElement;

export class HistoryTreeProvider extends WorkItemViewProvider {
  protected readonly groupPrefix = 'history';
  protected readonly groupContextValue = 'historyGroup';
  private readonly linkStore?: Pick<ItemLinkStore, 'getLinksForItem' | 'onDidChange'>;
  private readonly linkedChildrenCache = new Map<string, WorkItem[]>();
  private visibleItemsCache: Map<string, WorkItem> | undefined;

  constructor(
    workGraph: WorkGraph,
    providerRegistry?: ProviderRegistry,
    linkStore?: Pick<ItemLinkStore, 'getLinksForItem' | 'onDidChange'>,
  ) {
    const [lr, pce, tr, dice] = HistoryTreeProvider.buildProviderArgs(providerRegistry);
    super(workGraph, 'flat', lr, pce, tr, dice);
    this.linkStore = linkStore;
    if (this.linkStore) {
      this.disposables.push(this.linkStore.onDidChange(() => this.refresh()));
    }
  }

  override refresh(): void {
    this.linkedChildrenCache.clear();
    this.visibleItemsCache = undefined;
    super.refresh();
  }

  protected getItems(): WorkItem[] {
    return this.workGraph.getItemsByState(WorkItemState.Done, WorkItemState.Archived);
  }

  protected sortItems(items: WorkItem[]): WorkItem[] {
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  protected getItemChildren(item: WorkItem): WorkItem[] {
    if (isLinkedWorkItemNode(item) || !this.linkStore) {
      return [];
    }

    const cachedChildren = this.linkedChildrenCache.get(item.id);
    if (cachedChildren) {
      return cachedChildren;
    }

    const visibleItems = this.visibleItemsCache ?? new Map(this.getItems().map(visibleItem => [visibleItem.id, visibleItem]));
    this.visibleItemsCache = visibleItems;
    const linkedChildren = this.linkStore.getLinksForItem(item.id)
      .map((link) => {
        const childId = link.itemId1 === item.id ? link.itemId2 : link.itemId1;
        const child = visibleItems.get(childId);
        if (!child) {
          return undefined;
        }

        return {
          ...child,
          linkedParentId: item.id,
          linkedRelation: link.relation,
          linkedNodeId: `${child.id}::linked::${item.id}`,
        };
      })
      .filter((child): child is WorkItem & { linkedParentId: string; linkedRelation: 'closes' | 'linked'; linkedNodeId: string } => child !== undefined);

    const sortedChildren = sortLinkedNodes(linkedChildren);
    this.linkedChildrenCache.set(item.id, sortedChildren);
    return sortedChildren;
  }

  protected createWorkItemTreeItem(item: WorkItem): vscode.TreeItem {
    const title = this.resolveTitle(item);
    const relationDescription = this.getRelationDescription(item);
    const stateLabel = this.getStateLabel(item.state);
    const treeItem = new vscode.TreeItem(
      title,
      this.hasItemChildren(item) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    treeItem.id = isLinkedWorkItemNode(item) ? item.linkedNodeId : item.id;
    treeItem.description = this.layout === 'tree'
      ? this.buildDescription(stateLabel, relationDescription)
      : this.buildDescription(item.group, this.getProviderLabel(item.providerId), stateLabel, relationDescription);
    treeItem.tooltip = buildWorkItemTooltip(item, title, {
      timestamp: 'updatedAt',
      timestampLabel: item.state === WorkItemState.Done ? 'Completed at'
        : item.state === WorkItemState.Archived ? 'Archived at'
        : 'Last updated',
    });
    treeItem.iconPath = getWorkItemIcon(item.state);
    let contextBase = 'historyItem';
    if (item.state === WorkItemState.Done) {
      contextBase = 'historyItem.done';
    } else if (item.state === WorkItemState.Archived) {
      contextBase = 'historyItem.archived';
    }
    treeItem.contextValue = item.url ? `${contextBase}.hasUrl` : contextBase;
    treeItem.command = { command: 'devdocket.editItem', title: 'Open Details', arguments: [item] };
    return treeItem;
  }

  private getRelationDescription(item: WorkItem): string | undefined {
    if (!isLinkedWorkItemNode(item)) {
      return undefined;
    }

    const parent = this.workGraph.getItem(item.linkedParentId);
    return buildLinkDescription(item.linkedRelation, parent?.externalId, parent?.title);
  }

  private getStateLabel(state: WorkItemState): string {
    switch (state) {
      case WorkItemState.Done:
        return 'done';
      case WorkItemState.Archived:
        return 'archived';
      default:
        return state;
    }
  }

}
