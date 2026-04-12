import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import {
  WorkItemElement, WorkItemViewProvider, isProviderGroupNode, isSubGroupNode,
} from './viewLayout';

export type QueueElement = WorkItemElement;

const DRAG_MIME_TYPE = 'application/vnd.code.tree.workcenter.queue';

export class QueueTreeProvider extends WorkItemViewProvider implements vscode.TreeDragAndDropController<QueueElement> {
  readonly dropMimeTypes = [DRAG_MIME_TYPE];
  readonly dragMimeTypes = [DRAG_MIME_TYPE];
  protected readonly groupPrefix = 'queue';
  protected readonly groupContextValue = 'queueGroup';

  constructor(workGraph: WorkGraph, providerRegistry?: ProviderRegistry) {
    super(workGraph, 'flat', providerRegistry ? id => providerRegistry.getProviderLabel(id) : undefined);
  }

  protected getItems(): WorkItem[] {
    return this.workGraph.getItemsByState(WorkItemState.New);
  }

  protected sortItems(items: WorkItem[]): WorkItem[] {
    return items.sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));
  }

  protected createWorkItemTreeItem(item: WorkItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    treeItem.id = item.id;
    treeItem.description = item.providerId;
    treeItem.tooltip = this.buildTooltip(item);
    treeItem.contextValue = item.url ? 'queueItem.hasUrl' : 'queueItem';
    treeItem.iconPath = new vscode.ThemeIcon(item.providerId ? 'remote' : 'circle-filled');
    treeItem.command = { command: 'workcenter.editItem', title: 'Open Details', arguments: [item] };
    return treeItem;
  }

  private buildTooltip(item: WorkItem): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Title:** `);
    md.appendText(item.title);
    md.appendMarkdown(`\n\n`);
    if (item.notes) { md.appendText(`${item.notes}\n\n`); }
    md.appendMarkdown(`Created: ${new Date(item.createdAt).toLocaleString()}`);
    return md;
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
