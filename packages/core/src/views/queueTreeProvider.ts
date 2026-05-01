import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import { ActionRegistry } from '../services/actionRegistry';
import {
  WorkItemElement, WorkItemViewProvider, isProviderGroupNode, isSubGroupNode,
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

  constructor(
    workGraph: WorkGraph,
    providerRegistry?: ProviderRegistry,
    actionRegistry?: ActionRegistry,
    isWatchable?: (url: string) => boolean,
  ) {
    const [lr, pce, tr, dice] = QueueTreeProvider.buildProviderArgs(providerRegistry);
    super(workGraph, 'flat', lr, pce, tr, dice);

    this.actionRegistry = actionRegistry;
    this.isWatchable = isWatchable;
    if (this.actionRegistry) {
      this.disposables.push(this.actionRegistry.onDidChangeRegistrations(() => this.refresh()));
    }
  }

  protected getItems(): WorkItem[] {
    return this.workGraph.getItemsByState(WorkItemState.New);
  }

  protected sortItems(items: WorkItem[]): WorkItem[] {
    return items.sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));
  }

  protected createWorkItemTreeItem(item: WorkItem): vscode.TreeItem {
    const title = this.resolveTitle(item);
    const treeItem = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
    treeItem.id = item.id;
    treeItem.description = this.layout === 'flat'
      ? this.buildDescription(item.group, this.getProviderLabel(item.providerId))
      : undefined;
    treeItem.tooltip = buildWorkItemTooltip(item, title, { showState: false, notesStyle: 'plain' });
    const urlSuffix = item.url ? '.hasUrl' : '';
    const watchableSuffix = item.url && this.isWatchable?.(item.url) ? '.watchable' : '';
    const hasActionsSuffix = this.actionRegistry?.getActionsFor(item).length ? '.hasActions' : '';
    treeItem.contextValue = `queueItem${urlSuffix}${watchableSuffix}${hasActionsSuffix}`;
    treeItem.iconPath = new vscode.ThemeIcon(item.providerId ? 'remote' : 'circle-filled');
    treeItem.command = { command: 'devdocket.editItem', title: 'Open Details', arguments: [item] };
    return treeItem;
  }

  handleDrag(source: readonly QueueElement[], dataTransfer: vscode.DataTransfer): void {
    const items = source.filter((s): s is WorkItem => !isProviderGroupNode(s) && !isSubGroupNode(s));
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

    if (draggedId === target.id) { return; }

    await this.workGraph.reorderItem(draggedId, target.id);
  }
}
