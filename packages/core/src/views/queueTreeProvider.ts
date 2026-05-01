import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import { ActionRegistry } from '../services/actionRegistry';
import type { ItemLinkStore } from '../storage/itemLinkStore';
import { buildLinkDescription, sortLinkedNodes } from './linkDisplay';
import {
  WorkItemElement, WorkItemViewProvider, isLinkedWorkItemNode, isProviderGroupNode, isSubGroupNode,
} from './viewLayout';
import { buildWorkItemTooltip } from './viewUtils';

export type QueueElement = WorkItemElement;

const DRAG_MIME_TYPE = 'application/vnd.code.tree.devdocket.queue';

export class QueueTreeProvider extends WorkItemViewProvider implements vscode.TreeDragAndDropController<QueueElement> {
  readonly dropMimeTypes = [DRAG_MIME_TYPE];
  readonly dragMimeTypes = [DRAG_MIME_TYPE];
  protected readonly groupPrefix = 'queue';
  protected readonly groupContextValue = 'queueGroup';
  private readonly actionRegistry?: ActionRegistry;
  private readonly isWatchable?: (url: string) => boolean;
  private readonly linkStore?: Pick<ItemLinkStore, 'getLinksForItem' | 'onDidChange'>;
  private readonly linkedChildrenCache = new Map<string, WorkItem[]>();
  private visibleItemsCache: Map<string, WorkItem> | undefined;

  constructor(
    workGraph: WorkGraph,
    providerRegistry?: ProviderRegistry,
    actionRegistry?: ActionRegistry,
    isWatchable?: (url: string) => boolean,
    linkStore?: Pick<ItemLinkStore, 'getLinksForItem' | 'onDidChange'>,
  ) {
    const [lr, pce, tr, dice] = QueueTreeProvider.buildProviderArgs(providerRegistry);
    super(workGraph, 'flat', lr, pce, tr, dice);

    this.actionRegistry = actionRegistry;
    this.isWatchable = isWatchable;
    this.linkStore = linkStore;
    if (this.actionRegistry) {
      this.disposables.push(this.actionRegistry.onDidChangeRegistrations(() => this.refresh()));
    }
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
    return this.workGraph.getItemsByState(WorkItemState.New);
  }

  protected sortItems(items: WorkItem[]): WorkItem[] {
    return items.sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));
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

        // If child is the source (e.g., the PR that declared "closes"), it's reverse direction
        const direction: 'forward' | 'reverse' = link.sourceItemId === childId ? 'reverse' : 'forward';
        return {
          ...child,
          linkedParentId: item.id,
          linkedRelation: link.relation,
          linkedDirection: direction,
          linkedNodeId: `${child.id}::linked::${item.id}`,
        };
      })
      .filter((child): child is WorkItem & { linkedParentId: string; linkedRelation: 'closes' | 'linked'; linkedDirection: 'forward' | 'reverse'; linkedNodeId: string } => child !== undefined);

    const sortedChildren = sortLinkedNodes(linkedChildren);
    this.linkedChildrenCache.set(item.id, sortedChildren);
    return sortedChildren;
  }

  protected createWorkItemTreeItem(item: WorkItem): vscode.TreeItem {
    const title = this.resolveTitle(item);
    const relationDescription = this.getRelationDescription(item);
    const treeItem = new vscode.TreeItem(
      title,
      this.hasItemChildren(item) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    treeItem.id = isLinkedWorkItemNode(item) ? item.linkedNodeId : item.id;
    treeItem.description = this.layout === 'flat'
      ? this.buildDescription(item.group, this.getProviderLabel(item.providerId), relationDescription)
      : relationDescription;
    treeItem.tooltip = buildWorkItemTooltip(item, title, { showState: false, notesStyle: 'plain' });
    const urlSuffix = item.url ? '.hasUrl' : '';
    const watchableSuffix = item.url && this.isWatchable?.(item.url) ? '.watchable' : '';
    const hasActionsSuffix = this.actionRegistry?.hasActionsFor(item) ? '.hasActions' : '';
    treeItem.contextValue = `queueItem${urlSuffix}${watchableSuffix}${hasActionsSuffix}`;
    treeItem.iconPath = new vscode.ThemeIcon(item.providerId ? 'remote' : 'circle-filled');
    treeItem.command = { command: 'devdocket.editItem', title: 'Open Details', arguments: [item] };
    return treeItem;
  }

  private getRelationDescription(item: WorkItem): string | undefined {
    if (!isLinkedWorkItemNode(item)) {
      return undefined;
    }

    const parent = this.workGraph.getItem(item.linkedParentId);
    return buildLinkDescription(item.linkedRelation, item.linkedDirection ?? 'forward', parent?.externalId, parent?.title);
  }

  handleDrag(source: readonly QueueElement[], dataTransfer: vscode.DataTransfer): void {
    const items = source.filter((s): s is WorkItem => !isProviderGroupNode(s) && !isSubGroupNode(s) && !isLinkedWorkItemNode(s));
    if (items.length === 0) { return; }
    dataTransfer.set(DRAG_MIME_TYPE, new vscode.DataTransferItem(items.map(s => s.id)));
  }

  async handleDrop(target: QueueElement | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const transferItem = dataTransfer.get(DRAG_MIME_TYPE);
    if (!transferItem) { return; }

    const rawValue: unknown = transferItem.value;
    if (!Array.isArray(rawValue) || rawValue.length !== 1 || typeof rawValue[0] !== 'string') { return; }

    const draggedId: string = rawValue[0];

    // Group node targets or no target → move to end
    if (!target || isProviderGroupNode(target) || isSubGroupNode(target)) {
      await this.workGraph.moveToEnd(draggedId);
      return;
    }

    if (isLinkedWorkItemNode(target) || draggedId === target.id) { return; }

    await this.workGraph.reorderItem(draggedId, target.id);
  }
}
