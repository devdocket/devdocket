import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import {
  WorkItemElement, WorkItemViewProvider, SubGroupNode, isProviderGroupNode, isSubGroupNode, createSubGroupTreeItem,
} from './viewLayout';

const DRAG_MIME_TYPE = 'application/vnd.code.tree.devdocket.focus';

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
      providerRegistry ? (pid, eid) => providerRegistry.getDiscoveredItems(pid).find(d => d.externalId === eid)?.title : undefined,
      providerRegistry?.onDidChangeDiscoveredItems,
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
    const title = this.resolveTitle(item);
    const treeItem = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
    treeItem.id = item.id;
    treeItem.description = this.layout === 'tree'
      ? undefined
      : this.buildDescription(item.group, this.getProviderLabel(item.providerId));
    treeItem.tooltip = this.buildTooltip(item, title);
    treeItem.iconPath = this.getIcon(item.state);

    // contextValue controls which context menu items appear
    if (item.state === WorkItemState.Paused) {
      treeItem.contextValue = item.url ? 'paused.hasUrl' : 'paused';
    } else {
      treeItem.contextValue = item.url ? 'active.hasUrl' : 'active';
    }

    treeItem.command = { command: 'devdocket.editItem', title: 'Open Details', arguments: [item] };
    return treeItem;
  }

  getTreeItem(element: FocusElement): vscode.TreeItem {
    if (isSubGroupNode(element)) {
      const count = this.getItems().filter(
        i => (i.group?.trim() || undefined) === element.groupName
      ).length;
      return createSubGroupTreeItem(element, this.groupPrefix, count);
    }
    return super.getTreeItem(element);
  }

  getChildren(element?: FocusElement): FocusElement[] {
    if (!element) {
      const items = this.getItems();
      if (this.layout === 'flat') {
        return this.sortItems(items);
      }
      return this.getGroupRootChildren(items);
    }

    if (isSubGroupNode(element)) {
      return this.sortItems(
        this.getItems().filter(i => (i.group?.trim() || undefined) === element.groupName),
      );
    }

    return [];
  }

  /** Group items by `item.group` (repo name) at the top level in tree mode. */
  private getGroupRootChildren(items: WorkItem[]): (SubGroupNode | WorkItem)[] {
    const groups = new Set<string>();
    const ungrouped: WorkItem[] = [];

    for (const item of items) {
      const g = item.group?.trim();
      if (g) {
        groups.add(g);
      } else {
        ungrouped.push(item);
      }
    }

    const subGroups: SubGroupNode[] = [];
    for (const groupName of groups) {
      subGroups.push({ kind: 'subGroup', label: groupName, providerId: undefined, groupName });
    }

    const sortedSubGroups = subGroups.sort((a, b) => a.label.localeCompare(b.label));
    const sortedUngrouped = this.sortItems(ungrouped);

    return [...sortedSubGroups, ...sortedUngrouped];
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
        'DevDocket: Cannot reorder items across different states.'
      );
      return;
    }

    await this.workGraph.reorderItem(draggedId, target.id);
  }

  private buildTooltip(item: WorkItem, title: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Title:** `);
    md.appendText(title);
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
