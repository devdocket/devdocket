import * as vscode from 'vscode';
import { ProviderRegistry } from '../services/providerRegistry';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';

export interface InboxProviderNode {
  kind: 'provider';
  providerId: string;
  label: string;
}

export interface InboxItem {
  kind: 'item';
  providerId: string;
  externalId: string;
  title: string;
  description?: string;
  url?: string;
}

export type InboxElement = InboxProviderNode | InboxItem;

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
        // Prune seenItems to only retain keys for items still visible in the Inbox
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
        this._onDidChangeTreeData.fire();
      }),
      stateStore.onDidChange(() => this._onDidChangeTreeData.fire())
    );
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
      const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      treeItem.description = `${count}`;
      treeItem.contextValue = 'inboxProvider';
      treeItem.iconPath = new vscode.ThemeIcon('plug');
      return treeItem;
    }

    const key = `${element.providerId}::${element.externalId}`;
    const isSeen = this.seenItems.has(key);

    const treeItem = new vscode.TreeItem(
      isSeen ? element.title : { label: element.title, highlights: [[0, element.title.length]] },
      vscode.TreeItemCollapsibleState.None,
    );
    treeItem.tooltip = this.buildTooltip(element);
    treeItem.contextValue = element.url ? 'inboxItem.hasUrl' : 'inboxItem';
    treeItem.iconPath = new vscode.ThemeIcon('mail');
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

    return [];
  }

  private getProviderChildren(providerId: string): InboxItem[] {
    const items = this.providerRegistry.getDiscoveredItems(providerId);
    const result: InboxItem[] = [];
    for (const item of items) {
      const state = this.stateStore.getState(providerId, item.externalId);
      if (state === undefined || state === 'unseen') {
        result.push({
          kind: 'item',
          providerId,
          externalId: item.externalId,
          title: item.title,
          description: item.description,
          url: item.url,
        });
      }
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
