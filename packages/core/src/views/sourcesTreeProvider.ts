import * as vscode from 'vscode';
import { DiscoveredItem } from '../api/types';
import { ProviderRegistry } from '../services/providerRegistry';
import { DiscoveredStateStore, InboxState } from '../storage/discoveredStateStore';
import { buildLinkDescription, sortLinkedNodes } from './linkDisplay';
import { ViewLayout, LayoutState } from './viewLayout';
import { buildProviderTooltip } from './providerTooltip';

export type SourcesElement = SourceProviderNode | SourceGroupNode | SourceItemNode;

export interface SourceProviderNode {
  kind: 'provider';
  providerId: string;
  label: string;
}

export interface SourceGroupNode {
  kind: 'group';
  providerId: string;
  groupName: string;
}

export interface SourceItemNode {
  kind: 'item';
  providerId: string;
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  group?: string;
  canonicalId?: string;
  linkedParentProviderId?: string;
  linkedParentExternalId?: string;
  linkedRelation?: 'closes' | 'linked';
  linkedNodeId?: string;
}

export class SourcesTreeProvider implements vscode.TreeDataProvider<SourcesElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _layoutState: LayoutState;
  private _countsCache: Map<string, number> | undefined;
  private linkedChildrenCache = new Map<string, SourceItemNode[]>();
  private visibleItemsByExternalIdCache: Map<string, Array<{ providerId: string; item: DiscoveredItem }>> | undefined;

  get layout(): ViewLayout { return this._layoutState.value; }
  set layout(value: ViewLayout) { this._layoutState.value = value; }

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly stateStore: DiscoveredStateStore,
  ) {
    this._layoutState = new LayoutState('tree', () => {
      this._countsCache = undefined;
      this._onDidChangeTreeData.fire();
    });
    this.disposables.push(
      providerRegistry.onDidChangeDiscoveredItems(() => {
        this._countsCache = undefined;
        this.linkedChildrenCache.clear();
        this.visibleItemsByExternalIdCache = undefined;
        this._onDidChangeTreeData.fire();
      }),
      providerRegistry.onDidChangeProviderHealth(() => {
        this._countsCache = undefined;
        this._onDidChangeTreeData.fire();
      }),
      stateStore.onDidChange(() => {
        this._countsCache = undefined;
        this._onDidChangeTreeData.fire();
      })
    );
  }

  refresh(): void {
    this._countsCache = undefined;
    this.linkedChildrenCache.clear();
    this.visibleItemsByExternalIdCache = undefined;
    this._onDidChangeTreeData.fire();
  }

  private ensureCountsCache(): Map<string, number> {
    if (!this._countsCache) {
      const counts = new Map<string, number>();
      const allItems = this.providerRegistry.getAllDiscoveredItems();
      for (const [providerId, items] of allItems) {
        const providerKey = `provider:${providerId}`;
        counts.set(providerKey, items.length);

        for (const item of items) {
          const normalizedGroup = item.group?.trim();
          if (normalizedGroup) {
            const groupKey = `group:${providerId}:${normalizedGroup}`;
            counts.set(groupKey, (counts.get(groupKey) ?? 0) + 1);
          }
        }
      }
      this._countsCache = counts;
    }
    return this._countsCache;
  }

  getTreeItem(element: SourcesElement): vscode.TreeItem {
    switch (element.kind) {
      case 'provider': {
        const health = this.providerRegistry.getProviderHealth(element.providerId);
        const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
        treeItem.contextValue = 'sourceProvider';
        if (health.status === 'unhealthy') {
          treeItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
          treeItem.description = 'refresh failed';
        } else {
          const counts = this.ensureCountsCache();
          const providerKey = `provider:${element.providerId}`;
          const count = counts.get(providerKey) ?? 0;
          treeItem.iconPath = new vscode.ThemeIcon('plug');
          treeItem.description = `${count}`;
        }
        treeItem.tooltip = buildProviderTooltip(element.label, health);
        return treeItem;
      }
      case 'group': {
        const counts = this.ensureCountsCache();
        const groupKey = `group:${element.providerId}:${element.groupName}`;
        const count = counts.get(groupKey) ?? 0;
        const treeItem = new vscode.TreeItem(element.groupName, vscode.TreeItemCollapsibleState.Collapsed);
        treeItem.contextValue = 'sourceGroup';
        treeItem.description = `${count}`;
        treeItem.iconPath = new vscode.ThemeIcon('folder');
        return treeItem;
      }
      case 'item': {
        const state = this.stateStore.getState(element.providerId, element.externalId);
        let icon: string;
        switch (state) {
          case 'accepted':
            icon = 'check';
            break;
          case 'dismissed':
            icon = 'circle-slash';
            break;
          default:
            icon = 'circle-outline';
            break;
        }
        const relationDescription = this.getRelationDescription(element);
        const treeItem = new vscode.TreeItem(
          element.title,
          this.hasLinkedChildren(element) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        treeItem.id = element.linkedNodeId ?? `sources::item::${element.providerId}::${element.externalId}`;
        treeItem.description = this.buildItemDescription(element.providerId, element.group, state, relationDescription);
        treeItem.tooltip = this.buildItemTooltip(element);
        treeItem.contextValue = element.url ? 'sourceItem.hasUrl' : 'sourceItem';
        treeItem.iconPath = new vscode.ThemeIcon(icon);
        return treeItem;
      }
    }
  }

  getParent(element: SourcesElement): SourcesElement | undefined {
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
      case 'item':
        if (element.linkedParentProviderId && element.linkedParentExternalId) {
          return this.getSourceItemNode(element.linkedParentProviderId, element.linkedParentExternalId);
        }
        if (element.group) {
          return { kind: 'group', providerId: element.providerId, groupName: element.group };
        }
        return {
          kind: 'provider',
          providerId: element.providerId,
          label: this.providerRegistry.getProviderLabel(element.providerId),
        };
    }
  }

  getChildren(element?: SourcesElement): SourcesElement[] {
    if (!element) {
      if (this._layoutState.value === 'flat') {
        return this.getAllItems();
      }
      const result: SourceProviderNode[] = [];
      const allItems = this.providerRegistry.getAllDiscoveredItems();
      for (const [providerId, items] of allItems) {
        const health = this.providerRegistry.getProviderHealth(providerId);
        if (items.length > 0 || health.status === 'unhealthy') {
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

    return this.getLinkedChildren(element);
  }

  private getAllItems(): SourceItemNode[] {
    const result: SourceItemNode[] = [];
    const allItems = this.providerRegistry.getAllDiscoveredItems();
    for (const [providerId, items] of allItems) {
      for (const item of items) {
        result.push(this.toItemNode(providerId, item));
      }
    }
    return result.sort((a, b) => a.title.localeCompare(b.title));
  }

  private getProviderChildren(providerId: string): SourcesElement[] {
    const items = this.providerRegistry.getDiscoveredItems(providerId);
    const groups = new Set<string>();
    const ungrouped: DiscoveredItem[] = [];

    for (const item of items) {
      const normalizedGroup = item.group?.trim();
      if (normalizedGroup) {
        groups.add(normalizedGroup);
      } else {
        ungrouped.push(item);
      }
    }

    const result: SourcesElement[] = [];

    for (const groupName of groups) {
      result.push({ kind: 'group', providerId, groupName });
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

  private getGroupChildren(providerId: string, groupName: string): SourceItemNode[] {
    const items = this.providerRegistry.getDiscoveredItems(providerId);
    return items
      .filter((item) => item.group?.trim() === groupName)
      .map((item) => this.toItemNode(providerId, item))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  private getLinkedChildren(parent: SourceItemNode): SourceItemNode[] {
    if (parent.linkedParentProviderId || parent.linkedParentExternalId) {
      return [];
    }

    const cacheKey = `${parent.providerId}::${parent.externalId}`;
    const cachedChildren = this.linkedChildrenCache.get(cacheKey);
    if (cachedChildren) {
      return cachedChildren;
    }

    const sourceItem = this.findDiscoveredItem(parent.providerId, parent.externalId);
    if (!sourceItem?.relatedItems?.length) {
      return [];
    }

    const visibleItemsByExternalId = this.getVisibleItemsByExternalId();
    const linkedChildren = sourceItem.relatedItems
      .flatMap((relatedItem) => (visibleItemsByExternalId.get(relatedItem.externalId) ?? [])
        // Sources nesting only shows linked items from other provider groups.
        .filter(match => match.providerId !== parent.providerId)
        .map(match => this.toItemNode(match.providerId, match.item, {
          linkedParentProviderId: parent.providerId,
          linkedParentExternalId: parent.externalId,
          linkedRelation: relatedItem.relation,
          linkedNodeId: `sources::item::${match.providerId}::${match.item.externalId}::linked::${parent.providerId}::${parent.externalId}`,
        })))
      .filter((item, index, items) => items.findIndex(candidate => candidate.linkedNodeId === item.linkedNodeId) === index);

    const sortedChildren = sortLinkedNodes(linkedChildren as Array<SourceItemNode & { linkedRelation: 'closes' | 'linked' }>);
    this.linkedChildrenCache.set(cacheKey, sortedChildren);
    return sortedChildren;
  }

  private hasLinkedChildren(item: SourceItemNode): boolean {
    return !item.linkedParentProviderId && !item.linkedParentExternalId && this.getLinkedChildren(item).length > 0;
  }

  private getRelationDescription(item: SourceItemNode): string | undefined {
    if (!item.linkedRelation || !item.linkedParentProviderId || !item.linkedParentExternalId) {
      return undefined;
    }

    const parent = this.findDiscoveredItem(item.linkedParentProviderId, item.linkedParentExternalId);
    return buildLinkDescription(item.linkedRelation, parent?.externalId, parent?.title);
  }

  private findDiscoveredItem(providerId: string, externalId: string): DiscoveredItem | undefined {
    return this.providerRegistry.getDiscoveredItems(providerId)
      .find(item => item.externalId === externalId);
  }

  private getSourceItemNode(providerId: string, externalId: string): SourceItemNode | undefined {
    const item = this.findDiscoveredItem(providerId, externalId);
    return item ? this.toItemNode(providerId, item) : undefined;
  }

  private getVisibleItemsByExternalId(): Map<string, Array<{ providerId: string; item: DiscoveredItem }>> {
    if (this.visibleItemsByExternalIdCache) {
      return this.visibleItemsByExternalIdCache;
    }

    const visibleItemsByExternalId = new Map<string, Array<{ providerId: string; item: DiscoveredItem }>>();

    for (const [providerId, items] of this.providerRegistry.getAllDiscoveredItems()) {
      for (const item of items) {
        const matches = visibleItemsByExternalId.get(item.externalId) ?? [];
        matches.push({ providerId, item });
        visibleItemsByExternalId.set(item.externalId, matches);
      }
    }

    this.visibleItemsByExternalIdCache = visibleItemsByExternalId;
    return visibleItemsByExternalId;
  }

  private toItemNode(providerId: string, item: DiscoveredItem, linkedItem?: Partial<SourceItemNode>): SourceItemNode {
    return {
      kind: 'item',
      providerId,
      externalId: item.externalId,
      title: item.title,
      description: item.description,
      url: item.url,
      group: item.group?.trim() || undefined,
      canonicalId: item.canonicalId,
      ...linkedItem,
    };
  }

  private buildItemDescription(
    providerId: string,
    group: string | undefined,
    state: InboxState | undefined,
    relationDescription?: string,
  ): string | undefined {
    const parts: string[] = [];
    if (this._layoutState.value === 'flat') {
      const groupLabel = group?.trim();
      if (groupLabel && groupLabel.length > 0) { parts.push(groupLabel); }
      const label = this.providerRegistry.getProviderLabel(providerId)?.trim();
      if (label && label.length > 0) { parts.push(label); }
    }
    if (state === 'dismissed') { parts.push('dismissed'); }
    if (relationDescription) { parts.push(relationDescription); }
    return parts.length > 0 ? parts.join(' · ') : undefined;
  }

  private buildItemTooltip(item: SourceItemNode): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Title:** `);
    md.appendText(item.title);
    md.appendMarkdown(`\n\n`);
    return md;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
