import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';

const DRAG_MIME_TYPE = 'application/vnd.code.tree.workcenter.queue';

export class QueueTreeProvider implements vscode.TreeDataProvider<WorkItem>, vscode.TreeDragAndDropController<WorkItem> {
  readonly dropMimeTypes = [DRAG_MIME_TYPE];
  readonly dragMimeTypes = [DRAG_MIME_TYPE];
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly workGraph: WorkGraph) {
    this.disposables.push(
      workGraph.onDidChange(() => this._onDidChangeTreeData.fire())
    );
  }

  refresh(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(item: WorkItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    treeItem.id = item.id;
    treeItem.description = item.providerId;
    treeItem.tooltip = this.buildTooltip(item);
    treeItem.contextValue = item.url ? 'queueItem.hasUrl' : 'queueItem';
    treeItem.iconPath = new vscode.ThemeIcon(item.providerId ? 'remote' : 'circle-filled');
    treeItem.command = { command: 'workcenter.editItem', title: 'Open Details', arguments: [item] };
    return treeItem;
  }

  getChildren(): WorkItem[] {
    return this.workGraph.getItemsByState(WorkItemState.New)
      .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));
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

  handleDrag(source: readonly WorkItem[], dataTransfer: vscode.DataTransfer): void {
    dataTransfer.set(DRAG_MIME_TYPE, new vscode.DataTransferItem(source.map(s => s.id)));
  }

  async handleDrop(target: WorkItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
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

    if (draggedId === target.id) { return; }

    await this.workGraph.reorderItem(draggedId, target.id);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
