import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';

export class FocusTreeProvider implements vscode.TreeDataProvider<WorkItem> {
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

    // contextValue controls which context menu items appear
    if (item.state === WorkItemState.Blocked) {
      treeItem.contextValue = item.url ? 'blocked.hasUrl' : 'blocked';
    } else if (item.state === WorkItemState.WaitingOn) {
      treeItem.contextValue = item.url ? 'waitingOn.hasUrl' : 'waitingOn';
    } else if (item.state === WorkItemState.Paused) {
      treeItem.contextValue = item.url ? 'paused.hasUrl' : 'paused';
    } else {
      treeItem.contextValue = item.url ? 'active.hasUrl' : 'active';
    }

    return treeItem;
  }

  getChildren(): WorkItem[] {
    return this.workGraph.getItemsByState(
      WorkItemState.InProgress,
      WorkItemState.Paused,
      WorkItemState.Blocked,
      WorkItemState.WaitingOn,
    ).sort((a, b) => a.title.localeCompare(b.title));
  }

  private getStateLabel(state: WorkItemState): string {
    switch (state) {
      case WorkItemState.InProgress:
        return 'in progress';
      case WorkItemState.Paused:
        return '⏸ paused';
      case WorkItemState.Blocked:
        return '🚫 blocked';
      case WorkItemState.WaitingOn:
        return '⏳ waiting';
      default:
        return state;
    }
  }

  private getIcon(state: WorkItemState): vscode.ThemeIcon {
    switch (state) {
      case WorkItemState.InProgress:
        return new vscode.ThemeIcon('play-circle');
      case WorkItemState.Paused:
        return new vscode.ThemeIcon('debug-pause');
      case WorkItemState.Blocked:
        return new vscode.ThemeIcon('error');
      case WorkItemState.WaitingOn:
        return new vscode.ThemeIcon('watch');
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }

  private buildTooltip(item: WorkItem): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Title:** `);
    md.appendText(item.title);
    md.appendMarkdown(`\n\n`);
    if (item.notes) {
      md.appendMarkdown(`**Notes:** `);
      md.appendText(item.notes);
      md.appendMarkdown(`\n\n`);
    }
    md.appendMarkdown(`**State:** ${item.state}\n\n`);
    md.appendMarkdown(`**Created:** ${new Date(item.createdAt).toLocaleString()}`);
    return md;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
