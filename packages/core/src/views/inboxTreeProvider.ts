import * as vscode from 'vscode';
import { ProviderRegistry } from '../services/providerRegistry';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';

export interface InboxProviderNode {
  kind: 'provider';
  providerId: string;
  label: string;
}

export interface InboxGroupNode {
  kind: 'group';
  providerId: string;
  groupName: string;
  unseenCount: number;
}

export interface InboxItem {
  kind: 'item';
  providerId: string;
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  group?: string;
}

export type InboxElement = InboxProviderNode | InboxGroupNode | InboxItem;

export class InboxTreeProvider implements vscode.TreeDataProvider<InboxElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly seenItems = new Set<string>();

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly stateStore: DiscoveredStateStore,
  ) {
    this.disposables.push(
      providerRegistry.onDidChangeDiscoveredItems(() => {
        this.pruneSeenItems();
        this._onDidChangeTreeData.fire();
      }),
      stateStore.onDidChange(() => {
        this.pruneSeenItems();
        this._onDidChangeTreeData.fire();
      })
    );
  }

  private pruneSeenItems(): void {
    const currentKeys = new Set<string>();
    for (const [providerId, items] of this.providerRegistry.getAllDiscoveredItems()) {
      for (const item of items) {
        const state = this.stateStore.getState(providerId, item.externalId);
        if (state === undefined || state === 'unseen') {
          currentKeys.add(`${providerId}::${item.externalId}`);
        }
      }
    }
    for (const key of this.seenItems) {
      if (!currentKeys.has(key)) {
        this.seenItems.delete(key);
      }
    }
  }

  refresh(): void { this._onDidChangeTreeData.fire(); }

  markSeen(providerId: string, externalId: string): boolean {
    const key = `${providerId}::${externalId}`;
    if (!this.seenItems.has(key)) {
      this.seenItems.add(key);
      return true;
    }
    return false;
  }

  getTreeItem(element: InboxElement): vscode.TreeItem {
    if (element.kind === 'provider') {
      const count = this.getUnseenCount(element.providerId);
      const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.description = `${count}`;
      treeItem.contextValue = 'inboxProvider';
      treeItem.iconPath = new vscode.ThemeIcon('plug');
      return treeItem;
    }

    if (element.kind === 'group') {
      const treeItem = new vscode.TreeItem(element.groupName, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.description = `${element.unseenCount}`;
      treeItem.contextValue = 'inboxGroup';
      treeItem.iconPath = new vscode.ThemeIcon('folder');
      return treeItem;
    }

    const key = `${element.providerId}::${element.externalId}`;
    const isSeen = this.seenItems.has(key);

    const treeItem = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None);
    treeItem.tooltip = this.buildTooltip(element);
    treeItem.contextValue = element.url ? 'inboxItem.hasUrl' : 'inboxItem';
    treeItem.iconPath = new vscode.ThemeIcon(isSeen ? 'circle-outline' : 'circle-filled');
    return treeItem;
  }

  getChildren(element?: InboxElement): InboxElement[] {
    if (!element) {
      const result: InboxProviderNode[] = [];
      const allItems = this.providerRegistry.getAllDiscoveredItems();
      for (const [providerId] of allItems) {
        if (this.getUnseenCount(providerId) > 0) {
          result.push({
            kind: 'provider',
            providerId,
            label: this.providerRegistry.getProviderLabel(providerId),
          });
        }
      }
      return result.sort((a, b) => a.label.localeCompare(b.label));
    }

    if (element.kind === 'provider') {
      return this.getProviderChildren(element.providerId);
    }

    if (element.kind === 'group') {
      return this.getGroupChildren(element.providerId, element.groupName);
    }

    return [];
  }

  private getProviderChildren(providerId: string): (InboxGroupNode | InboxItem)[] {
    const items = this.providerRegistry.getDiscoveredItems(providerId);
    const groupCounts = new Map<string, number>();
    const ungrouped: typeof items = [];

    for (const item of items) {
      const state = this.stateStore.getState(providerId, item.externalId);
      if (state !== undefined && state !== 'unseen') { continue; }

      if (item.group) {
        groupCounts.set(item.group, (groupCounts.get(item.group) ?? 0) + 1);
      } else {
        ungrouped.push(item);
      }
    }

    const result: (InboxGroupNode | InboxItem)[] = [];

    for (const [groupName, unseenCount] of groupCounts) {
      result.push({ kind: 'group', providerId, groupName, unseenCount });
    }

    for (const item of ungrouped) {
      result.push({
        kind: 'item',
        providerId,
        externalId: item.externalId,
        title: item.title,
        description: item.description,
        url: item.url,
      });
    }

    return result.sort((a, b) => {
      const aLabel = a.kind === 'group' ? a.groupName : a.title;
      const bLabel = b.kind === 'group' ? b.groupName : b.title;
      return aLabel.localeCompare(bLabel);
    });
  }

  private getGroupChildren(providerId: string, groupName: string): InboxItem[] {
    const items = this.providerRegistry.getDiscoveredItems(providerId);
    const result: InboxItem[] = [];
    for (const item of items) {
      if (item.group !== groupName) { continue; }
      const state = this.stateStore.getState(providerId, item.externalId);
      if (state !== undefined && state !== 'unseen') { continue; }
      result.push({
        kind: 'item',
        providerId,
        externalId: item.externalId,
        title: item.title,
        description: item.description,
        url: item.url,
        group: item.group,
      });
    }
    return result.sort((a, b) => a.title.localeCompare(b.title));
  }

  private getUnseenCount(providerId: string): number {
    const items = this.providerRegistry.getDiscoveredItems(providerId);
    return items.filter((item) => {
      const state = this.stateStore.getState(providerId, item.externalId);
      return state === undefined || state === 'unseen';
    }).length;
  }

  private buildTooltip(item: InboxItem): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${item.title}**\n\n`);
    if (item.description) { md.appendText(`${item.description}\n\n`); }
    return md;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
