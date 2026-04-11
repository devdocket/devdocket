import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import {
  ViewLayout, ProviderGroupNode, isProviderGroupNode,
  LayoutState, getTreeModeChildren, createProviderGroupTreeItem,
} from './viewLayout';

export type QueueElement = WorkItem | ProviderGroupNode;

const DRAG_MIME_TYPE = 'application/vnd.code.tree.workcenter.queue';

export class QueueTreeProvider implements vscode.TreeDataProvider<QueueElement>, vscode.TreeDragAndDropController<QueueElement> {
  readonly dropMimeTypes = [DRAG_MIME_TYPE];
  readonly dragMimeTypes = [DRAG_MIME_TYPE];
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _layoutState: LayoutState;

  get layout(): ViewLayout { return this._layoutState.value; }
  set layout(value: ViewLayout) { this._layoutState.value = value; }

  constructor(private readonly workGraph: WorkGraph) {
    this._layoutState = new LayoutState('flat', () => this._onDidChangeTreeData.fire());
    this.disposables.push(
      workGraph.onDidChange(() => this._onDidChangeTreeData.fire())
    );
  }

  refresh(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(element: QueueElement): vscode.TreeItem {
    if (isProviderGroupNode(element)) {
      return createProviderGroupTreeItem(element, 'queue', 'queueGroup');
    }

    const item = element;
    const treeItem = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    treeItem.id = item.id;
    treeItem.description = item.providerId;
    treeItem.tooltip = this.buildTooltip(item);
    treeItem.contextValue = item.url ? 'queueItem.hasUrl' : 'queueItem';
    treeItem.iconPath = new vscode.ThemeIcon(item.providerId ? 'remote' : 'circle-filled');
    treeItem.command = { command: 'workcenter.editItem', title: 'Open Details', arguments: [item] };
    return treeItem;
  }

  private readonly sortBySortOrder = (items: WorkItem[]): WorkItem[] =>
    items.sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));

  getChildren(element?: QueueElement): QueueElement[] {
    return getTreeModeChildren(
      element,
      () => this.workGraph.getItemsByState(WorkItemState.New),
      this.sortBySortOrder,
      this._layoutState.value,
    );
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
    const items = source.filter((s): s is WorkItem => !isProviderGroupNode(s));
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
    if (!target || isProviderGroupNode(target)) {
      await this.workGraph.moveToEnd(draggedId);
      return;
    }

    if (draggedId === target.id) { return; }

    await this.workGraph.reorderItem(draggedId, target.id);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
