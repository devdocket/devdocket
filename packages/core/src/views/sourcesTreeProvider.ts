import * as vscode from 'vscode';
import { DiscoveredItem } from '../api/types';
import { ProviderRegistry } from '../services/providerRegistry';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { ViewLayout, LayoutState } from './viewLayout';

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
}

export class SourcesTreeProvider implements vscode.TreeDataProvider<SourcesElement> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _layoutState: LayoutState;

  get layout(): ViewLayout { return this._layoutState.value; }
  set layout(value: ViewLayout) { this._layoutState.value = value; }

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly stateStore: DiscoveredStateStore,
  ) {
    this._layoutState = new LayoutState('tree', () => this._onDidChangeTreeData.fire());
    this.disposables.push(
      providerRegistry.onDidChangeDiscoveredItems(() => this._onDidChangeTreeData.fire()),
      stateStore.onDidChange(() => this._onDidChangeTreeData.fire())
    );
  }

  refresh(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(element: SourcesElement): vscode.TreeItem {
    switch (element.kind) {
      case 'provider': {
        const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
        treeItem.contextValue = 'sourceProvider';
        treeItem.iconPath = new vscode.ThemeIcon('plug');
        return treeItem;
      }
      case 'group': {
        const treeItem = new vscode.TreeItem(element.groupName, vscode.TreeItemCollapsibleState.Collapsed);
        treeItem.contextValue = 'sourceGroup';
        treeItem.iconPath = new vscode.ThemeIcon('folder');
        return treeItem;
      }
      case 'item': {
        const state = this.stateStore.getState(element.providerId, element.externalId);
        const icon = state === 'accepted' ? 'check' : 'circle-outline';
        const treeItem = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None);
        treeItem.description = state === 'dismissed' ? 'dismissed' : undefined;
        treeItem.tooltip = this.buildItemTooltip(element);
        treeItem.contextValue = element.url ? 'sourceItem.hasUrl' : 'sourceItem';
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
        if (items.length > 0) {
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
    const groups = new Map<string, DiscoveredItem[]>();
    const ungrouped: DiscoveredItem[] = [];

    for (const item of items) {
      if (item.group) {
        const list = groups.get(item.group) ?? [];
        list.push(item);
        groups.set(item.group, list);
      } else {
        ungrouped.push(item);
      }
    }

    const result: SourcesElement[] = [];

    for (const [groupName] of groups) {
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
      .filter((item) => item.group === groupName)
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
      group: item.group,
    };
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
