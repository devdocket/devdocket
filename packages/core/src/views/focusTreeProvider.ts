import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import {
  WorkItemElement, WorkItemViewProvider, isProviderGroupNode, isSubGroupNode,
} from './viewLayout';

const DRAG_MIME_TYPE = 'application/vnd.code.tree.workcenter.focus';

export type FocusElement = WorkItemElement;

export class FocusTreeProvider extends WorkItemViewProvider implements vscode.TreeDragAndDropController<FocusElement> {
  readonly dropMimeTypes = [DRAG_MIME_TYPE];
  readonly dragMimeTypes = [DRAG_MIME_TYPE];
  protected readonly groupPrefix = 'focus';
  protected readonly groupContextValue = 'focusGroup';

  constructor(workGraph: WorkGraph, providerRegistry?: ProviderRegistry) {
    super(
      workGraph,
      'flat',
      providerRegistry ? id => providerRegistry.getProviderLabel(id) : undefined,
      providerRegistry?.onDidRegisterProvider,
    );
  }

  protected getItems(): WorkItem[] {
    return this.workGraph.getItemsByState(WorkItemState.InProgress, WorkItemState.Paused);
  }

  protected sortItems(items: WorkItem[]): WorkItem[] {
    return items.sort((a, b) => {
      const statePriorityDifference = this.getFocusStatePriority(a.state) - this.getFocusStatePriority(b.state);
      if (statePriorityDifference !== 0) {
        return statePriorityDifference;
      }
      return (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER);
    });
  }

  protected createWorkItemTreeItem(item: WorkItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    treeItem.id = item.id;
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

  private getFocusStatePriority(state: WorkItemState): number {
    switch (state) {
      case WorkItemState.InProgress:
        return 0;
      case WorkItemState.Paused:
        return 1;
      default:
        return Number.MAX_SAFE_INTEGER;
    }
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

  handleDrag(source: readonly FocusElement[], dataTransfer: vscode.DataTransfer): void {
    const items = source.filter((s): s is WorkItem => !isProviderGroupNode(s) && !isSubGroupNode(s));
    if (items.length === 0) { return; }
    dataTransfer.set(DRAG_MIME_TYPE, new vscode.DataTransferItem(items.map(s => s.id)));
  }

  async handleDrop(target: FocusElement | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const transferItem = dataTransfer.get(DRAG_MIME_TYPE);
    if (!transferItem) { return; }

    const rawValue: unknown = transferItem.value;
    if (!Array.isArray(rawValue) || rawValue.length !== 1 || typeof rawValue[0] !== 'string') { return; }

    const draggedIds: string[] = rawValue;
    const draggedId = draggedIds[0];

    // Group node targets or no target → move to end
    if (!target || isProviderGroupNode(target) || isSubGroupNode(target)) {
      await this.workGraph.moveToEnd(draggedId);
      return;
    }

    if (draggedId === target.id) { return; }

    const draggedItem = this.workGraph.getItem(draggedId);
    if (!draggedItem) { return; }

    if (draggedItem.state !== target.state) {
      void vscode.window.showInformationMessage(
        'WorkCenter: Cannot reorder items across different states.'
      );
      return;
    }

    await this.workGraph.reorderItem(draggedId, target.id);
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
