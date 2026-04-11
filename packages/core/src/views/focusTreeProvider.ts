import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import {
  WorkItemElement, WorkItemViewProvider,
} from './viewLayout';

export type FocusElement = WorkItemElement;

export class FocusTreeProvider extends WorkItemViewProvider {
  protected readonly groupPrefix = 'focus';
  protected readonly groupContextValue = 'focusGroup';

  constructor(workGraph: WorkGraph) {
    super(workGraph, 'flat');
  }

  protected getItems(): WorkItem[] {
    return this.workGraph.getItemsByState(WorkItemState.InProgress, WorkItemState.Paused);
  }

  protected sortItems(items: WorkItem[]): WorkItem[] {
    return items.sort((a, b) => a.title.localeCompare(b.title));
  }

  protected createWorkItemTreeItem(item: WorkItem): vscode.TreeItem {
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
}
