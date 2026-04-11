import * as vscode from 'vscode';
import { DiscoveredItem } from '../api/types';
import { ProviderRegistry } from '../services/providerRegistry';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { ReadStateStore } from '../storage/readStateStore';
import { logger } from '../services/logger';
import { ViewLayout } from './viewLayout';

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
  reason?: string;
}

export type InboxElement = InboxProviderNode | InboxGroupNode | InboxItem;

export class InboxTreeProvider implements vscode.TreeDataProvider<InboxElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly seenItems = new Set<string>();
  private readonly _onDidMarkSeen = new vscode.EventEmitter<void>();
  readonly onDidMarkSeen = this._onDidMarkSeen.event;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  static readonly REFRESH_DEBOUNCE_MS = 50;
  private _layout: ViewLayout = 'tree';

  get layout(): ViewLayout { return this._layout; }
  set layout(value: ViewLayout) {
    if (this._layout !== value) {
      this._layout = value;
      this._onDidChangeTreeData.fire();
    }
  }

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly stateStore: DiscoveredStateStore,
    private readonly readStateStore: ReadStateStore,
  ) {
    this.disposables.push(
      providerRegistry.onDidChangeDiscoveredItems(() => this.scheduleRefresh()),
      stateStore.onDidChange(() => this.scheduleRefresh()),
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.pruneSeenItems();
      this._onDidChangeTreeData.fire();
    }, InboxTreeProvider.REFRESH_DEBOUNCE_MS);
  }

  private pruneSeenItems(): void {
    // Skip pruning while providers are still loading or temporarily
    // unregistered to avoid wiping persisted read-state.
    if (this.providerRegistry.loading) { return; }
    const discoveredItems = this.providerRegistry.getAllDiscoveredItems();
    if (discoveredItems.size === 0) { return; }

    // Build current inbox keys, scoped to providers that have items.
    // Providers with empty item arrays (e.g. failed refresh) are excluded
    // so their read-state keys are preserved.
    const currentKeys = new Set<string>();
    const activeProviderIds = new Set<string>();
    for (const [providerId, items] of discoveredItems) {
      if (items.length === 0) { continue; }
      activeProviderIds.add(providerId);
      for (const item of items) {
        const state = this.stateStore.getState(providerId, item.externalId);
        if (state === undefined || state === 'unseen') {
          currentKeys.add(`${providerId}::${item.externalId}`);
        }
      }
    }
    if (activeProviderIds.size === 0) { return; }

    const keysToDelete: string[] = [];
    for (const key of this.readStateStore.keys()) {
      const providerId = key.split('::')[0];
      // Only prune keys belonging to providers that have active items
      if (activeProviderIds.has(providerId) && !currentKeys.has(key)) {
        keysToDelete.push(key);
      }
    }
    if (keysToDelete.length > 0) {
      void this.readStateStore.deleteMany(keysToDelete).catch(err =>
        logger.error('Failed to prune read state', err)
      );
    }
  }

  get sessionSeenItems(): ReadonlySet<string> { return this.seenItems; }

  refresh(): void { this._onDidChangeTreeData.fire(); }

  async markSeen(providerId: string, externalId: string): Promise<boolean> {
    const key = `${providerId}::${externalId}`;
    if (!this.seenItems.has(key)) {
      this.seenItems.add(key);
      this._onDidMarkSeen.fire();
    }
    return this.readStateStore.add(key);
  }

  getTreeItem(element: InboxElement): vscode.TreeItem {
    if (element.kind === 'provider') {
      const count = this.getUnseenCount(element.providerId);
      const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.description = `${count}`;
      treeItem.id = `inbox::provider::${element.providerId}`;
      treeItem.contextValue = 'inboxProvider';
      treeItem.iconPath = new vscode.ThemeIcon('plug');
      return treeItem;
    }

    if (element.kind === 'group') {
      const treeItem = new vscode.TreeItem(element.groupName, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.id = `inbox::group::${element.providerId}::${element.groupName}`;
      treeItem.description = `${element.unseenCount}`;
      treeItem.contextValue = 'inboxGroup';
      treeItem.iconPath = new vscode.ThemeIcon('folder');
      return treeItem;
    }

    const key = `${element.providerId}::${element.externalId}`;
    const isSeen = this.readStateStore.has(key);

    const treeItem = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None);
    treeItem.id = `inbox::item::${element.providerId}::${element.externalId}`;
    treeItem.tooltip = this.buildTooltip(element);
    treeItem.contextValue = element.url ? 'inboxItem.hasUrl' : 'inboxItem';
    treeItem.iconPath = new vscode.ThemeIcon(isSeen ? 'circle-outline' : 'circle-filled');
    return treeItem;
  }

  getParent(element: InboxElement): InboxElement | undefined {
    switch (element.kind) {
      case 'provider':
        return undefined;
      case 'group':
        return {
          kind: 'provider',
          providerId: element.providerId,
          label: this.providerRegistry.getProviderLabel(element.providerId),
        };
      case 'item': {
        if (element.group) {
          const unseenCount = this.getGroupUnseenCount(element.providerId, element.group);
          return {
            kind: 'group',
            providerId: element.providerId,
            groupName: element.group,
            unseenCount,
          };
        }
        return {
          kind: 'provider',
          providerId: element.providerId,
          label: this.providerRegistry.getProviderLabel(element.providerId),
        };
      }
    }
  }

  getChildren(element?: InboxElement): InboxElement[] {
    if (!element) {
      if (this._layout === 'flat') {
        return this.getAllUnseenItems();
      }
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

  private getAllUnseenItems(): InboxItem[] {
    const result: InboxItem[] = [];
    const allItems = this.providerRegistry.getAllDiscoveredItems();
    for (const [providerId, items] of allItems) {
      for (const item of items) {
        const state = this.stateStore.getState(providerId, item.externalId);
        if (state !== undefined && state !== 'unseen') { continue; }
        result.push(this.toItemNode(providerId, item));
      }
    }
    return result.sort((a, b) => a.title.localeCompare(b.title));
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
      result.push(this.toItemNode(providerId, item));
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
      result.push(this.toItemNode(providerId, item));
    }
    return result.sort((a, b) => a.title.localeCompare(b.title));
  }

  private toItemNode(providerId: string, item: DiscoveredItem): InboxItem {
    return {
      kind: 'item',
      providerId,
      externalId: item.externalId,
      title: item.title,
      description: item.description,
      url: item.url,
      group: item.group,
      reason: item.reason,
    };
  }

  private getGroupUnseenCount(providerId: string, groupName: string): number {
    const items = this.providerRegistry.getDiscoveredItems(providerId);
    return items.filter((item) => {
      if (item.group !== groupName) { return false; }
      const state = this.stateStore.getState(providerId, item.externalId);
      return state === undefined || state === 'unseen';
    }).length;
  }

  private getUnseenCount(providerId: string): number {
    const items = this.providerRegistry.getDiscoveredItems(providerId);
    return items.filter((item) => {
      const state = this.stateStore.getState(providerId, item.externalId);
      return state === undefined || state === 'unseen';
    }).length;
  }

  private formatReason(reason: string): string {
    return reason.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  }

  private buildTooltip(item: InboxItem): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Title:** `);
    md.appendText(item.title);
    md.appendMarkdown(`\n\n`);
    if (item.reason) {
      md.appendMarkdown('*Reason: ');
      md.appendText(this.formatReason(item.reason));
      md.appendMarkdown('*\n\n');
    }
    if (item.description) { md.appendText(`${item.description}\n\n`); }
    return md;
  }

  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this._onDidChangeTreeData.dispose();
    this._onDidMarkSeen.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
