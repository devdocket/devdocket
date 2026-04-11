import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import {
  ViewLayout, ProviderGroupNode, isProviderGroupNode,
  LayoutState, getTreeModeChildren, createProviderGroupTreeItem,
} from './viewLayout';

export type HistoryElement = WorkItem | ProviderGroupNode;

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryElement> {
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

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: HistoryElement): vscode.TreeItem {
    if (isProviderGroupNode(element)) {
      return createProviderGroupTreeItem(element, 'history', 'historyGroup');
    }

    const item = element;
    const treeItem = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    treeItem.description = this.getStateLabel(item.state);
    treeItem.tooltip = this.buildTooltip(item);
    treeItem.iconPath = this.getIcon(item.state);
    treeItem.contextValue = item.url ? 'historyItem.hasUrl' : 'historyItem';
    treeItem.command = { command: 'workcenter.editItem', title: 'Open Details', arguments: [item] };
    return treeItem;
  }

  getChildren(element?: HistoryElement): HistoryElement[] {
    return getTreeModeChildren(
      element,
      () => this.workGraph.getItemsByState(WorkItemState.Done, WorkItemState.Archived),
      items => items.sort((a, b) => b.updatedAt - a.updatedAt),
      this._layoutState.value,
    );
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
    if (item.notes) {
      md.appendMarkdown(`**Notes:** `);
      md.appendText(item.notes);
      md.appendMarkdown(`\n\n`);
    }
    md.appendMarkdown(`**State:** ${item.state}\n\n`);
    const timestampLabel = item.state === WorkItemState.Done ? 'Completed at' : item.state === WorkItemState.Archived ? 'Archived at' : 'Last updated';
    md.appendMarkdown(`**${timestampLabel}:** ${new Date(item.updatedAt).toLocaleString()}`);
    return md;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
