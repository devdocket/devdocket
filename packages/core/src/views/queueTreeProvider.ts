import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ViewLayout, ProviderGroupNode, isProviderGroupNode } from './viewLayout';

export type QueueElement = WorkItem | ProviderGroupNode;

const DRAG_MIME_TYPE = 'application/vnd.code.tree.workcenter.queue';

export class QueueTreeProvider implements vscode.TreeDataProvider<QueueElement>, vscode.TreeDragAndDropController<QueueElement> {
  readonly dropMimeTypes = [DRAG_MIME_TYPE];
  readonly dragMimeTypes = [DRAG_MIME_TYPE];
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  private _layout: ViewLayout = 'flat';

  get layout(): ViewLayout { return this._layout; }
  set layout(value: ViewLayout) {
    if (this._layout !== value) {
      this._layout = value;
      this._onDidChangeTreeData.fire();
    }
  }

  constructor(private readonly workGraph: WorkGraph) {
    this.disposables.push(
      workGraph.onDidChange(() => this._onDidChangeTreeData.fire())
    );
  }

  refresh(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(element: QueueElement): vscode.TreeItem {
    if (isProviderGroupNode(element)) {
      const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.id = `queue::group::${element.providerId ?? '__other__'}`;
      treeItem.contextValue = 'queueGroup';
      treeItem.iconPath = new vscode.ThemeIcon(element.providerId ? 'plug' : 'circle-filled');
      return treeItem;
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

  getChildren(element?: QueueElement): QueueElement[] {
    if (!element) {
      const items = this.workGraph.getItemsByState(WorkItemState.New)
        .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));

      if (this._layout === 'flat') {
        return items;
      }

      return this.groupByProvider(items);
    }

    if (isProviderGroupNode(element)) {
      return this.workGraph.getItemsByState(WorkItemState.New)
        .filter(i => (i.providerId ?? undefined) === element.providerId)
        .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));
    }

    return [];
  }

  private groupByProvider(items: WorkItem[]): ProviderGroupNode[] {
    const groups = new Map<string | undefined, WorkItem[]>();
    for (const item of items) {
      const key = item.providerId ?? undefined;
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }

    const result: ProviderGroupNode[] = [];
    for (const [providerId] of groups) {
      result.push({
        kind: 'providerGroup',
        label: providerId ?? 'Other',
        providerId,
      });
    }
    return result.sort((a, b) => {
      // "Other" group always goes last
      if (!a.providerId) { return 1; }
      if (!b.providerId) { return -1; }
      return a.label.localeCompare(b.label);
    });
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
    // Treat group node targets as "move to end"
    if (target && isProviderGroupNode(target)) {
      target = undefined;
    }

    const transferItem = dataTransfer.get(DRAG_MIME_TYPE);
    if (!transferItem) { return; }

    const rawValue: unknown = transferItem.value;
    if (!Array.isArray(rawValue) || rawValue.length !== 1 || typeof rawValue[0] !== 'string') { return; }

    const draggedIds: string[] = rawValue;

    const draggedId = draggedIds[0];

    if (!target) {
      await this.workGraph.moveToEnd(draggedId);
      return;
    }

    if (draggedId === (target as WorkItem).id) { return; }

    await this.workGraph.reorderItem(draggedId, (target as WorkItem).id);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
