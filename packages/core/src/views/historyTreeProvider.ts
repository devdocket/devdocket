import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import {
  WorkItemElement, WorkItemViewProvider,
} from './viewLayout';
import { buildWorkItemTooltip, getWorkItemIcon, isPrUrl } from './viewUtils';

export type HistoryElement = WorkItemElement;

export class HistoryTreeProvider extends WorkItemViewProvider {
  protected readonly groupPrefix = 'history';
  protected readonly groupContextValue = 'historyGroup';

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
    return this.workGraph.getItemsByState(WorkItemState.Done, WorkItemState.Archived);
  }

  protected sortItems(items: WorkItem[]): WorkItem[] {
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  protected createWorkItemTreeItem(item: WorkItem): vscode.TreeItem {
    const title = this.resolveTitle(item);
    const treeItem = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
    treeItem.id = item.id;
    treeItem.description = this.layout === 'tree'
      ? this.getStateLabel(item.state)
      : this.buildDescription(item.group, this.getProviderLabel(item.providerId), this.getStateLabel(item.state));
    treeItem.tooltip = buildWorkItemTooltip(item, title, {
      timestamp: 'updatedAt',
      timestampLabel: item.state === WorkItemState.Done ? 'Completed at'
        : item.state === WorkItemState.Archived ? 'Archived at'
        : 'Last updated',
    });
    treeItem.iconPath = getWorkItemIcon(item.state);
    let contextBase = 'historyItem';
    if (item.state === WorkItemState.Done) {
      contextBase = 'historyItem.done';
    } else if (item.state === WorkItemState.Archived) {
      contextBase = 'historyItem.archived';
    }
    let contextValue = contextBase;
    if (item.url) {
      contextValue += '.hasUrl';
      if (isPrUrl(item.url)) {
        contextValue += '.hasPrUrl';
      }
    }
    treeItem.contextValue = contextValue;
    treeItem.command = { command: 'devdocket.editItem', title: 'Open Details', arguments: [item] };
    return treeItem;
  }

  private getStateLabel(state: WorkItemState): string {
    switch (state) {
      case WorkItemState.Done:
        return 'done';
      case WorkItemState.Archived:
        return 'archived';
      default:
        return state;
    }
  }

}
