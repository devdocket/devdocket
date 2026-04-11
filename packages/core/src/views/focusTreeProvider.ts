import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ViewLayout, ProviderGroupNode, isProviderGroupNode } from './viewLayout';

export type FocusElement = WorkItem | ProviderGroupNode;

export class FocusTreeProvider implements vscode.TreeDataProvider<FocusElement> {
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

  getTreeItem(element: FocusElement): vscode.TreeItem {
    if (isProviderGroupNode(element)) {
      const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.id = `focus::group::${element.providerId ?? '__other__'}`;
      treeItem.contextValue = 'focusGroup';
      treeItem.iconPath = new vscode.ThemeIcon(element.providerId ? 'plug' : 'circle-filled');
      return treeItem;
    }

    const item = element;
    const treeItem = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    treeItem.description = this.getStateLabel(item.state);
    treeItem.tooltip = this.buildTooltip(item);
    treeItem.iconPath = this.getIcon(item.state);

    // contextValue controls which context menu items appear
    if (item.state === WorkItemState.Paused) {
      treeItem.contextValue = item.url ? 'paused.hasUrl' : 'paused';
    } else {
      treeItem.contextValue = item.url ? 'active.hasUrl' : 'active';
    }

    treeItem.command = { command: 'workcenter.editItem', title: 'Open Details', arguments: [item] };
    return treeItem;
  }

  getChildren(element?: FocusElement): FocusElement[] {
    if (!element) {
      const items = this.workGraph.getItemsByState(
        WorkItemState.InProgress,
        WorkItemState.Paused,
      );

      if (this._layout === 'flat') {
        return items.sort((a, b) => a.title.localeCompare(b.title));
      }

      return this.groupByProvider(items);
    }

    if (isProviderGroupNode(element)) {
      return this.workGraph.getItemsByState(WorkItemState.InProgress, WorkItemState.Paused)
        .filter(i => (i.providerId ?? undefined) === element.providerId)
        .sort((a, b) => a.title.localeCompare(b.title));
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
      case WorkItemState.InProgress:
        return 'in progress';
      case WorkItemState.Paused:
        return '⏸ paused';
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
