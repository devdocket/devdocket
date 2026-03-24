import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';

export class QueueTreeProvider implements vscode.TreeDataProvider<WorkItem> {
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
    treeItem.description = item.providerId;
    treeItem.tooltip = this.buildTooltip(item);
    treeItem.contextValue = item.url ? 'queueItem.hasUrl' : 'queueItem';
    treeItem.iconPath = new vscode.ThemeIcon(item.providerId ? 'remote' : 'circle-filled');
    return treeItem;
  }

  getChildren(): WorkItem[] {
    return this.workGraph.getItemsByState(WorkItemState.New);
  }

  private buildTooltip(item: WorkItem): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${item.title}**\n\n`);
    if (item.description) { md.appendText(`${item.description}\n\n`); }
    md.appendMarkdown(`Created: ${new Date(item.createdAt).toLocaleString()}`);
    return md;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
