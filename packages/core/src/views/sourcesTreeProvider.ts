import * as vscode from 'vscode';
import { DiscoveredItem } from '../api/types';
import { ProviderRegistry } from '../services/providerRegistry';
import { DiscoveredStateStore, InboxState } from '../storage/discoveredStateStore';
import { ViewLayout, LayoutState } from './viewLayout';
import { buildProviderTooltip } from './providerTooltip';
import { isPrUrl } from './viewUtils';

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
}

export class SourcesTreeProvider implements vscode.TreeDataProvider<SourcesElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _layoutState: LayoutState;
  private _countsCache: Map<string, number> | undefined;

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
        const treeItem = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None);
        treeItem.description = this.buildItemDescription(element.providerId, element.group, state);
        treeItem.tooltip = this.buildItemTooltip(element);
        let contextValue = 'sourceItem';
        if (element.url) {
          contextValue += '.hasUrl';
          if (isPrUrl(element.url)) {
            contextValue += '.hasPrUrl';
          }
        }
        treeItem.contextValue = contextValue;
        treeItem.iconPath = new vscode.ThemeIcon(icon);
        return treeItem;
      }
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

    return [];
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

  private toItemNode(providerId: string, item: DiscoveredItem): SourceItemNode {
    return {
      kind: 'item',
      providerId,
      externalId: item.externalId,
      title: item.title,
      description: item.description,
      url: item.url,
      group: item.group?.trim() || undefined,
      canonicalId: item.canonicalId,
    };
  }

  private buildItemDescription(providerId: string, group: string | undefined, state: InboxState | undefined): string | undefined {
    const parts: string[] = [];
    if (this._layoutState.value === 'flat') {
      const groupLabel = group?.trim();
      if (groupLabel && groupLabel.length > 0) { parts.push(groupLabel); }
      const label = this.providerRegistry.getProviderLabel(providerId)?.trim();
      if (label && label.length > 0) { parts.push(label); }
    }
    if (state === 'dismissed') { parts.push('dismissed'); }
    return parts.length > 0 ? parts.join(' · ') : undefined;
  }

  private buildItemTooltip(item: SourceItemNode): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Title:** `);
    md.appendText(item.title);
    md.appendMarkdown(`\n\n`);
    if (item.description) {
      md.appendMarkdown(`**Description:** `);
      md.appendText(item.description);
      md.appendMarkdown(`\n\n`);
    }
    return md;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
