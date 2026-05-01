import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { ActionRegistry } from '../services/actionRegistry';
import { logger } from '../services/logger';
import { ProviderRegistry } from '../services/providerRegistry';
import { WatcherService } from '../services/watcherService';
import { WorkGraph } from '../services/workGraph';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { ReadStateStore } from '../storage/readStateStore';
import { isSafeUrl } from '../utils/url';
import type { WebviewMessage } from './missionControlTypes';

export class MissionControlViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'devdocket.missionControl';
  private static readonly REFRESH_DEBOUNCE_MS = 50;

  private view?: vscode.WebviewView;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workGraph: WorkGraph,
    private readonly providerRegistry: ProviderRegistry,
    private readonly stateStore: DiscoveredStateStore,
    private readonly readStateStore: ReadStateStore,
    private readonly watcherService: WatcherService,
    private readonly actionRegistry: ActionRegistry,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview-dist')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });

    this.scheduleRefresh();
  }

  scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refresh();
    }, MissionControlViewProvider.REFRESH_DEBOUNCE_MS);
  }

  selectItem(itemId: string): void {
    void this.view?.webview.postMessage({ type: 'selectItem', itemId });
  }

  private refresh(): void {
    if (!this.view) {
      return;
    }

    void this.view.webview.postMessage({
      type: 'updateItems',
      tiers: [],
    });
    void this.view.webview.postMessage({
      type: 'updateSources',
      providers: [],
    });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'openItem':
        await vscode.commands.executeCommand('devdocket.editItem', { id: message.itemId });
        break;
      case 'acceptItem':
        await this.handleAcceptItem(message.providerId, message.externalId);
        break;
      case 'dismissItem':
        await this.handleDismissItem(message.providerId, message.externalId);
        break;
      case 'transitionState':
        await this.handleTransitionState(message.itemId, message.targetState);
        break;
      case 'reorderItems':
        break;
      case 'createItem':
        await vscode.commands.executeCommand('devdocket.createItem');
        break;
      case 'runAction':
        await vscode.commands.executeCommand('devdocket.runAction', { id: message.itemId });
        break;
      case 'openUrl':
        if (isSafeUrl(message.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      case 'switchTab':
        break;
    }
  }

  private async handleAcceptItem(providerId: string, externalId: string): Promise<void> {
    try {
      const existing = this.workGraph.findItemByProvenance(providerId, externalId);
      if (!existing) {
        const discoveredItem = this.providerRegistry.getDiscoveredItems(providerId).find(item => item.externalId === externalId);
        if (!discoveredItem) {
          logger.warn(`MissionControl: discovered item ${providerId}/${externalId} not found for accept`);
          return;
        }
        await this.workGraph.createItem(
          {
            title: discoveredItem.title,
            description: discoveredItem.description,
          },
          {
            providerId,
            externalId,
            url: discoveredItem.url,
            ...(discoveredItem.group ? { group: discoveredItem.group } : {}),
          },
        );
      }
      await this.stateStore.setState(providerId, externalId, 'accepted');
    } catch (err) {
      logger.error('MissionControl: accept failed', err);
      void vscode.window.showErrorMessage(`Failed to accept item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleDismissItem(providerId: string, externalId: string): Promise<void> {
    try {
      await this.stateStore.setState(providerId, externalId, 'dismissed');
    } catch (err) {
      logger.error('MissionControl: dismiss failed', err);
      void vscode.window.showErrorMessage(`Failed to dismiss item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleTransitionState(itemId: string, targetState: string): Promise<void> {
    try {
      const item = this.workGraph.getItem(itemId);
      if (!item) {
        logger.warn(`MissionControl: item ${itemId} not found for transition`);
        return;
      }
      await this.workGraph.transitionState(itemId, targetState as WorkItemState);
    } catch (err) {
      logger.error('MissionControl: transition failed', err);
      void vscode.window.showErrorMessage(`Failed to transition item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview-dist', 'sidebar.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Mission Control</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
      overflow-x: hidden;
    }
    #root { height: 100vh; display: flex; flex-direction: column; }
    .tab-bar {
      display: flex;
      border-bottom: 1px solid var(--vscode-widget-border);
      flex-shrink: 0;
    }
    .tab {
      flex: 1;
      padding: 8px 12px;
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab:hover {
      color: var(--vscode-foreground);
    }
    .tab.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-focusBorder);
    }
    .tab:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .tab-content {
      flex: 1;
      overflow-y: auto;
    }
    .mission-control {
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    .empty-state, .placeholder {
      padding: 16px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      font-style: italic;
    }
    :root {
      --tier-incoming: #3794FF;
      --tier-in-progress: #89D185;
      --tier-urgent: #F14C4C;
      --tier-ready: #6E6E6E;
      --tier-paused: #CCA700;
      --tier-done: #6E6E6E;
    }
    body.vscode-light {
      --tier-incoming: #005FB8;
      --tier-in-progress: #388A34;
      --tier-urgent: #CD2D2D;
      --tier-ready: #B0B0B0;
      --tier-paused: #BF8803;
      --tier-done: #B0B0B0;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
