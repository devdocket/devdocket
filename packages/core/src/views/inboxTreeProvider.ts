import * as vscode from 'vscode';
import { ProviderRegistry } from '../services/providerRegistry';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';

export interface InboxItem {
  providerId: string;
  externalId: string;
  title: string;
  description?: string;
  url?: string;
}

export class InboxTreeProvider implements vscode.TreeDataProvider<InboxItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly stateStore: DiscoveredStateStore,
  ) {
    providerRegistry.onDidChangeDiscoveredItems(() => this._onDidChangeTreeData.fire());
    stateStore.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(item: InboxItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    treeItem.description = this.providerRegistry.getProviderLabel(item.providerId);
    treeItem.tooltip = this.buildTooltip(item);
    treeItem.contextValue = item.url ? 'inboxItem.hasUrl' : 'inboxItem';
    treeItem.iconPath = new vscode.ThemeIcon('mail');
    return treeItem;
  }

  getChildren(): InboxItem[] {
    const result: InboxItem[] = [];
    const allItems = this.providerRegistry.getAllDiscoveredItems();
    for (const [providerId, items] of allItems) {
      for (const item of items) {
        const state = this.stateStore.getState(providerId, item.externalId);
        if (state === undefined || state === 'unseen') {
          result.push({
            providerId,
            externalId: item.externalId,
            title: item.title,
            description: item.description,
            url: item.url,
          });
        }
      }
    }
    return result;
  }

  private buildTooltip(item: InboxItem): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${item.title}**\n\n`);
    if (item.description) { md.appendText(`${item.description}\n\n`); }
    return md;
  }

  dispose(): void { this._onDidChangeTreeData.dispose(); }
}
