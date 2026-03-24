import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';

export class FocusTreeProvider implements vscode.TreeDataProvider<WorkItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly workGraph: WorkGraph) {
    workGraph.onDidChange(() => this._onDidChangeTreeData.fire());
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
    if (item.state === WorkItemState.Blocked || item.state === WorkItemState.WaitingOn) {
      treeItem.contextValue = 'blocked';
    } else {
      treeItem.contextValue = 'active';
    }

    return treeItem;
  }

  getChildren(): WorkItem[] {
    return this.workGraph.getItemsByState(
      WorkItemState.InProgress,
      WorkItemState.Blocked,
      WorkItemState.WaitingOn,
    );
  }

  private getStateLabel(state: WorkItemState): string {
    switch (state) {
      case WorkItemState.InProgress:
        return 'in progress';
      case WorkItemState.Blocked:
        return '⛔ blocked';
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
      case WorkItemState.Blocked:
        return new vscode.ThemeIcon('circle-slash');
      case WorkItemState.WaitingOn:
        return new vscode.ThemeIcon('clock');
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }

  private buildTooltip(item: WorkItem): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${item.title}**\n\n`);
    if (item.description) {
      md.appendMarkdown(`${item.description}\n\n`);
    }
    md.appendMarkdown(`State: ${item.state}\n\n`);
    md.appendMarkdown(`Created: ${new Date(item.createdAt).toLocaleString()}`);
    return md;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
