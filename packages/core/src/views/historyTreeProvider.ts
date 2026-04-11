import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ViewLayout, ProviderGroupNode, isProviderGroupNode } from './viewLayout';

export type HistoryElement = WorkItem | ProviderGroupNode;

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryElement> {
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

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: HistoryElement): vscode.TreeItem {
    if (isProviderGroupNode(element)) {
      const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.id = `history::group::${element.providerId ?? '__other__'}`;
      treeItem.contextValue = 'historyGroup';
      treeItem.iconPath = new vscode.ThemeIcon(element.providerId ? 'plug' : 'circle-filled');
      return treeItem;
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
    if (!element) {
      const items = this.workGraph.getItemsByState(
        WorkItemState.Done,
        WorkItemState.Archived,
      ).sort((a, b) => b.updatedAt - a.updatedAt);

      if (this._layout === 'flat') {
        return items;
      }

      return this.groupByProvider(items);
    }

    if (isProviderGroupNode(element)) {
      return this.workGraph.getItemsByState(WorkItemState.Done, WorkItemState.Archived)
        .filter(i => (i.providerId ?? undefined) === element.providerId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
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
      if (!a.providerId) { return 1; }
      if (!b.providerId) { return -1; }
      return a.label.localeCompare(b.label);
    });
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
