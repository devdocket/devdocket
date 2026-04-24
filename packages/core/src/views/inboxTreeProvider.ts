import * as vscode from 'vscode';
import { DiscoveredItem } from '../api/types';
import { ProviderRegistry } from '../services/providerRegistry';
import { buildCanonicalHiddenSet } from '../services/canonicalDedup';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { ReadStateStore } from '../storage/readStateStore';
import { logger } from '../services/logger';
import { ViewLayout, LayoutState } from './viewLayout';
import { buildProviderTooltip } from './providerTooltip';

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
  canonicalId?: string;
  isPullRequest?: boolean;
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
  private readonly _layoutState: LayoutState;
  private cachedHiddenSet: Set<string> | undefined;

  get layout(): ViewLayout { return this._layoutState.value; }
  set layout(value: ViewLayout) { this._layoutState.value = value; }

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly stateStore: DiscoveredStateStore,
    private readonly readStateStore: ReadStateStore,
  ) {
    this._layoutState = new LayoutState('tree', () => this._onDidChangeTreeData.fire());
    this.disposables.push(
      providerRegistry.onDidChangeDiscoveredItems(() => this.scheduleRefresh()),
      providerRegistry.onDidChangeProviderHealth(() => this.scheduleRefresh()),
      stateStore.onDidChange(() => this.scheduleRefresh()),
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.cachedHiddenSet = undefined;
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
    const peerKeys = this.findCanonicalPeerKeys(providerId, externalId);
    const allKeys = [key, ...peerKeys];
    const addedKeys: string[] = [];
    for (const k of allKeys) {
      if (!this.seenItems.has(k)) {
        this.seenItems.add(k);
        addedKeys.push(k);
      }
    }
    try {
      if (peerKeys.length > 0) {
        const newlyAdded = await this.readStateStore.addMany(allKeys);
        const changed = addedKeys.length > 0;
        if (changed) {
          this._onDidMarkSeen.fire();
        }
        return changed || newlyAdded.length > 0;
      }
      const persisted = await this.readStateStore.add(key);
      if (addedKeys.length > 0) {
        this._onDidMarkSeen.fire();
      }
      return persisted;
    } catch (err) {
      // Roll back in-memory state on persistence failure
      for (const k of addedKeys) {
        this.seenItems.delete(k);
      }
      throw err;
    }
  }

  /** Marks multiple items as seen in a single write operation. */
  async markSeenBatch(items: Array<{ providerId: string; externalId: string }>): Promise<boolean> {
    // Expand with canonical peers
    const allItems = new Set<string>();
    for (const item of items) {
      allItems.add(`${item.providerId}::${item.externalId}`);
      for (const peerKey of this.findCanonicalPeerKeys(item.providerId, item.externalId)) {
        allItems.add(peerKey);
      }
    }
    const keys = [...allItems];
    const newKeys = keys.filter(k => !this.seenItems.has(k));
    // Persist first so in-memory state stays consistent on write failure
    const newlyAdded = await this.readStateStore.addMany(keys);
    if (newKeys.length > 0) {
      for (const key of newKeys) {
        this.seenItems.add(key);
      }
      this._onDidMarkSeen.fire();
    }
    return newKeys.length > 0 || newlyAdded.length > 0;
  }

  /** Finds `providerId::externalId` keys of canonical peers for the given item, excluding already accepted/dismissed peers. */
  private findCanonicalPeerKeys(providerId: string, externalId: string): string[] {
    const items = this.providerRegistry.getDiscoveredItems(providerId);
    const item = items.find(i => i.externalId === externalId);
    if (!item?.canonicalId) { return []; }
    const peers: string[] = [];
    for (const [pid, pItems] of this.providerRegistry.getAllDiscoveredItems()) {
      for (const pi of pItems) {
        if (pi.canonicalId !== item.canonicalId) { continue; }
        if (pid === providerId && pi.externalId === externalId) { continue; }
        const state = this.stateStore.getState(pid, pi.externalId);
        if (state !== undefined && state !== 'unseen') { continue; }
        peers.push(`${pid}::${pi.externalId}`);
      }
    }
    return peers;
  }

  /** Checks if this item or any canonical peer is marked as read in the persistent store. */
  private isCanonicalGroupSeen(key: string, canonicalId?: string): boolean {
    if (this.readStateStore.has(key)) {
      return true;
    }
    if (!canonicalId) { return false; }
    for (const [pid, pItems] of this.providerRegistry.getAllDiscoveredItems()) {
      for (const pi of pItems) {
        if (pi.canonicalId !== canonicalId) { continue; }
        const peerKey = `${pid}::${pi.externalId}`;
        if (peerKey === key) { continue; }
        if (this.readStateStore.has(peerKey)) {
          return true;
        }
      }
    }
    return false;
  }

  getTreeItem(element: InboxElement): vscode.TreeItem {
    if (element.kind === 'provider') {
      const count = this.getUnseenCount(element.providerId);
      const health = this.providerRegistry.getProviderHealth(element.providerId);
      const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.description = `${count}`;
      treeItem.id = `inbox::provider::${element.providerId}`;
      treeItem.contextValue = 'inboxProvider';
      if (health.status === 'unhealthy') {
        treeItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      } else {
        treeItem.iconPath = new vscode.ThemeIcon('plug');
      }
      treeItem.tooltip = buildProviderTooltip(element.label, health);
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
    const isSeen = this.isCanonicalGroupSeen(key, element.canonicalId);

    const treeItem = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None);
    treeItem.id = `inbox::item::${element.providerId}::${element.externalId}`;
    treeItem.description = this._layoutState.value === 'flat'
      ? this.buildFlatDescription(element)
      : undefined;
    treeItem.tooltip = this.buildTooltip(element);
    let contextValue = 'inboxItem';
    if (element.url) {
      contextValue += '.hasUrl';
      if (element.isPullRequest) {
        contextValue += '.hasPrUrl';
      }
    }
    treeItem.contextValue = contextValue;
    treeItem.iconPath = new vscode.ThemeIcon(isSeen ? 'circle-outline' : 'circle-filled');
    return treeItem;
  }

  getParent(element: InboxElement): InboxElement | undefined {
    if (this._layoutState.value === 'flat') {
      return undefined;
    }
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
      if (this._layoutState.value === 'flat') {
        return this.getAllUnseenItems();
      }
      const result: InboxProviderNode[] = [];
      const allItems = this.providerRegistry.getAllDiscoveredItems();
      for (const [providerId] of allItems) {
        const health = this.providerRegistry.getProviderHealth(providerId);
        if (this.getUnseenCount(providerId) > 0 || health.status === 'unhealthy') {
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
    const hidden = this.getCanonicalHiddenSet();
    const allItems = this.providerRegistry.getAllDiscoveredItems();
    for (const [providerId, items] of allItems) {
      for (const item of items) {
        const state = this.stateStore.getState(providerId, item.externalId);
        if (state !== undefined && state !== 'unseen') { continue; }
        if (hidden.has(`${providerId}::${item.externalId}`)) { continue; }
        result.push(this.toItemNode(providerId, item));
      }
    }
    return result.sort((a, b) => a.title.localeCompare(b.title));
  }

  private getProviderChildren(providerId: string): (InboxGroupNode | InboxItem)[] {
    const items = this.providerRegistry.getDiscoveredItems(providerId);
    const hidden = this.getCanonicalHiddenSet();
    const groupCounts = new Map<string, number>();
    const ungrouped: typeof items = [];

    for (const item of items) {
      const state = this.stateStore.getState(providerId, item.externalId);
      if (state !== undefined && state !== 'unseen') { continue; }
      if (hidden.has(`${providerId}::${item.externalId}`)) { continue; }

      if (item.group?.trim()) {
        const normalizedGroup = item.group.trim();
        groupCounts.set(normalizedGroup, (groupCounts.get(normalizedGroup) ?? 0) + 1);
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
    const hidden = this.getCanonicalHiddenSet();
    const result: InboxItem[] = [];
    for (const item of items) {
      if (item.group?.trim() !== groupName) { continue; }
      const state = this.stateStore.getState(providerId, item.externalId);
      if (state !== undefined && state !== 'unseen') { continue; }
      if (hidden.has(`${providerId}::${item.externalId}`)) { continue; }
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
      group: item.group?.trim() || undefined,
      reason: item.reason,
      canonicalId: item.canonicalId,
      isPullRequest: item.isPullRequest,
    };
  }

  private getCanonicalHiddenSet(): Set<string> {
    if (!this.cachedHiddenSet) {
      this.cachedHiddenSet = buildCanonicalHiddenSet(
        this.providerRegistry.getAllDiscoveredItems(),
        (pid, eid) => this.stateStore.getState(pid, eid),
      );
    }
    return this.cachedHiddenSet;
  }

  private getGroupUnseenCount(providerId: string, groupName: string): number {
    const items = this.providerRegistry.getDiscoveredItems(providerId);
    const hidden = this.getCanonicalHiddenSet();
    return items.filter((item) => {
      if (item.group?.trim() !== groupName) { return false; }
      const state = this.stateStore.getState(providerId, item.externalId);
      if (state !== undefined && state !== 'unseen') { return false; }
      return !hidden.has(`${providerId}::${item.externalId}`);
    }).length;
  }

  private getUnseenCount(providerId: string): number {
    const items = this.providerRegistry.getDiscoveredItems(providerId);
    const hidden = this.getCanonicalHiddenSet();
    return items.filter((item) => {
      const state = this.stateStore.getState(providerId, item.externalId);
      if (state !== undefined && state !== 'unseen') { return false; }
      return !hidden.has(`${providerId}::${item.externalId}`);
    }).length;
  }

  private formatReason(reason: string): string {
    return reason.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  }

  private buildFlatDescription(item: InboxItem): string | undefined {
    const parts = [
      item.group?.trim(),
      this.providerRegistry.getProviderLabel(item.providerId)?.trim(),
    ].filter((p): p is string => p !== undefined && p.length > 0);
    return parts.length > 0 ? parts.join(' · ') : undefined;
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
