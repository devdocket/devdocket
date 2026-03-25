import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';

export class HistoryTreeProvider implements vscode.TreeDataProvider<WorkItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly workGraph: WorkGraph) {
    this.disposables.push(
      workGraph.onDidChange(() => this._onDidChangeTreeData.fire())
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item: WorkItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    treeItem.description = this.getStateLabel(item.state);
    treeItem.tooltip = this.buildTooltip(item);
    treeItem.iconPath = this.getIcon(item.state);
    treeItem.contextValue = item.url ? 'historyItem.hasUrl' : 'historyItem';
    return treeItem;
  }

  getChildren(): WorkItem[] {
    return this.workGraph.getItemsByState(
      WorkItemState.Done,
      WorkItemState.Archived,
    ).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private getStateLabel(state: WorkItemState): string {
    switch (state) {
      case WorkItemState.Done:
        return '✓ done';
      case WorkItemState.Archived:
        return '📦 archived';
      default:
        return state;
    }
  }

  private getIcon(state: WorkItemState): vscode.ThemeIcon {
    switch (state) {
      case WorkItemState.Done:
        return new vscode.ThemeIcon('check');
      case WorkItemState.Archived:
        return new vscode.ThemeIcon('archive');
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }

  private buildTooltip(item: WorkItem): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Title:** `);
    md.appendText(item.title);
    md.appendMarkdown(`\n\n`);
    if (item.description) {
      md.appendMarkdown(`**Description:** `);
      md.appendText(item.description);
      md.appendMarkdown(`\n\n`);
    }
    md.appendMarkdown(`**State:** ${item.state}\n\n`);
    md.appendMarkdown(`**Completed:** ${new Date(item.updatedAt).toLocaleString()}`);
    return md;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
