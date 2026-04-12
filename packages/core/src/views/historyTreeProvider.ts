import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import {
  WorkItemElement, WorkItemViewProvider,
} from './viewLayout';

export type HistoryElement = WorkItemElement;

export class HistoryTreeProvider extends WorkItemViewProvider {
  protected readonly groupPrefix = 'history';
  protected readonly groupContextValue = 'historyGroup';

  constructor(workGraph: WorkGraph, providerRegistry?: ProviderRegistry) {
    super(workGraph, 'flat', providerRegistry ? id => providerRegistry.getProviderLabel(id) : undefined);
  }

  protected getItems(): WorkItem[] {
    return this.workGraph.getItemsByState(WorkItemState.Done, WorkItemState.Archived);
  }

  protected sortItems(items: WorkItem[]): WorkItem[] {
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  protected createWorkItemTreeItem(item: WorkItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    treeItem.description = this.getStateLabel(item.state);
    treeItem.tooltip = this.buildTooltip(item);
    treeItem.iconPath = this.getIcon(item.state);
    let contextBase = 'historyItem';
    if (item.state === WorkItemState.Done) {
      contextBase = 'historyItem.done';
    } else if (item.state === WorkItemState.Archived) {
      contextBase = 'historyItem.archived';
    }
    treeItem.contextValue = item.url ? `${contextBase}.hasUrl` : contextBase;
    treeItem.command = { command: 'workcenter.editItem', title: 'Open Details', arguments: [item] };
    return treeItem;
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
}
