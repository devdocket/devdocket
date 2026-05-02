import * as vscode from 'vscode';
import type { DiscoveredItem } from '../api/types';
import { logger } from '../services/logger';
import { ProviderRegistry } from '../services/providerRegistry';
import { WorkGraph } from '../services/workGraph';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { ReadStateStore } from '../storage/readStateStore';
import { isSafeUrl } from '../utils/url';
import { getEditorPanelHtml, renderMarkdown } from './editorPanelHtml';
import type { EditorItemData } from './mainTypes';
import { buildBadges, getUnrecognizedProviderState } from './badges';

/**
 * Read-only "preview" editor panel for an incoming/discovered item that does
 * not yet have a backing WorkItem.
 *
 * Reuses the editor's HTML shell and Preact bundle so the user sees the same
 * familiar layout (title, badges, description, action bar) — but with all
 * editing disabled and only Accept / Dismiss / Open in Browser available.
 *
 * Accept materializes a WorkItem and replaces this preview with the regular
 * editor; Dismiss closes the preview.
 */
export class IncomingPreviewPanel {
  private static readonly viewType = 'devdocket.previewItem';
  private static readonly openPanels = new Map<string, IncomingPreviewPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly providerRegistry: ProviderRegistry;
  private readonly stateStore: DiscoveredStateStore;
  private readonly readStateStore: ReadStateStore;
  private readonly workGraph: WorkGraph;
  private readonly providerId: string;
  private readonly externalId: string;
  private readonly extensionUri: vscode.Uri;
  private readonly subscriptions: vscode.Disposable[] = [];
  private htmlInitialized = false;
  private disposed = false;

  static open(
    context: vscode.ExtensionContext,
    providerRegistry: ProviderRegistry,
    stateStore: DiscoveredStateStore,
    readStateStore: ReadStateStore,
    workGraph: WorkGraph,
    providerId: string,
    externalId: string,
  ): void {
    const key = IncomingPreviewPanel.cacheKey(providerId, externalId);
    const existing = IncomingPreviewPanel.openPanels.get(key);
    if (existing) {
      existing.update();
      existing.panel.reveal();
      return;
    }

    const discoveredItem = providerRegistry
      .getDiscoveredItems(providerId)
      .find(item => item.externalId === externalId);
    if (!discoveredItem) {
      void vscode.window.showWarningMessage('Item is no longer available from the provider.');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      IncomingPreviewPanel.viewType,
      `Preview: ${discoveredItem.title}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview-dist')],
      },
    );

    const preview = new IncomingPreviewPanel(panel, providerRegistry, stateStore, readStateStore, workGraph, providerId, externalId, context.extensionUri);
    IncomingPreviewPanel.openPanels.set(key, preview);
    context.subscriptions.push({ dispose: () => preview.dispose() });
  }

  private constructor(
    panel: vscode.WebviewPanel,
    providerRegistry: ProviderRegistry,
    stateStore: DiscoveredStateStore,
    readStateStore: ReadStateStore,
    workGraph: WorkGraph,
    providerId: string,
    externalId: string,
    extensionUri: vscode.Uri,
  ) {
    this.panel = panel;
    this.providerRegistry = providerRegistry;
    this.stateStore = stateStore;
    this.readStateStore = readStateStore;
    this.workGraph = workGraph;
    this.providerId = providerId;
    this.externalId = externalId;
    this.extensionUri = extensionUri;

    this.update();

    this.subscriptions.push(
      this.providerRegistry.onDidChangeDiscoveredItems(() => this.update()),
      this.stateStore.onDidChange(() => this.checkInboxState()),
      this.panel.webview.onDidReceiveMessage((msg) => {
        void this.handleMessage(msg);
      }),
    );

    this.panel.onDidDispose(() => this.dispose());
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    const message = msg as { type?: string; url?: string; text?: string; providerId?: string; externalId?: string };

    switch (message.type) {
      case 'openUrl':
        if (typeof message.url === 'string') {
          const safe = isSafeUrl(message.url);
          if (safe) {
            await vscode.env.openExternal(vscode.Uri.parse(safe.href));
          }
        }
        break;
      case 'copyToClipboard':
        if (typeof message.text === 'string') {
          await vscode.env.clipboard.writeText(message.text);
        }
        break;
      case 'acceptItem':
        await this.acceptAndOpen();
        break;
      case 'dismissItem':
        await this.dismiss();
        break;
      // Autosave, transitions, runAction, openItem are no-ops in preview mode.
      default:
        break;
    }
  }

  private async acceptAndOpen(): Promise<void> {
    try {
      const discoveredItem = this.findDiscoveredItem();
      if (!discoveredItem) {
        void vscode.window.showWarningMessage('Item is no longer available from the provider.');
        return;
      }

      let existing = this.workGraph.findItemByProvenance(this.providerId, this.externalId);
      if (!existing) {
        await this.workGraph.createItem(
          { title: discoveredItem.title, description: discoveredItem.description },
          {
            providerId: this.providerId,
            externalId: this.externalId,
            url: discoveredItem.url,
            ...(discoveredItem.group ? { group: discoveredItem.group } : {}),
          },
        );
        existing = this.workGraph.findItemByProvenance(this.providerId, this.externalId);
      }

      await this.stateStore.setState(this.providerId, this.externalId, 'accepted');

      if (existing) {
        await vscode.commands.executeCommand('devdocket.editItem', { id: existing.id });
      }

      this.dispose();
    } catch (err) {
      logger.error('IncomingPreview: accept failed', err);
      void vscode.window.showErrorMessage(`Failed to accept item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async dismiss(): Promise<void> {
    try {
      await this.stateStore.setState(this.providerId, this.externalId, 'dismissed');
      this.dispose();
    } catch (err) {
      logger.error('IncomingPreview: dismiss failed', err);
      void vscode.window.showErrorMessage(`Failed to dismiss item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** If the item has been accepted/dismissed elsewhere, close the preview. */
  private checkInboxState(): void {
    const inboxState = this.stateStore.getState(this.providerId, this.externalId);
    if (inboxState === 'accepted' || inboxState === 'dismissed') {
      this.dispose();
    }
  }

  private update(): void {
    if (this.disposed) return;
    const discoveredItem = this.findDiscoveredItem();
    if (!discoveredItem) {
      // The provider no longer surfaces this item; close the preview.
      this.dispose();
      return;
    }

    const editorItem = this.buildEditorItemData(discoveredItem);
    this.panel.title = `Preview: ${discoveredItem.title}`;

    if (!this.htmlInitialized) {
      this.panel.webview.html = this.getHtml(editorItem);
      this.htmlInitialized = true;
      // Mark as seen so the unread indicator clears once the user opens the preview.
      void this.readStateStore.add(`${this.providerId}::${this.externalId}`).catch(() => {});
      return;
    }

    void this.panel.webview.postMessage({ type: 'updateEditorItem', item: editorItem });
  }

  private findDiscoveredItem(): DiscoveredItem | undefined {
    return this.providerRegistry
      .getDiscoveredItems(this.providerId)
      .find(item => item.externalId === this.externalId);
  }

  private buildEditorItemData(discoveredItem: DiscoveredItem): EditorItemData {
    const providerLabel = this.providerRegistry.getProviderLabel(this.providerId);
    return {
      id: `${this.providerId}::${this.externalId}`,
      title: discoveredItem.title,
      notes: undefined,
      url: discoveredItem.url,
      description: discoveredItem.description ? renderMarkdown(discoveredItem.description) : undefined,
      state: 'New',
      providerLabel,
      providerState: getUnrecognizedProviderState(discoveredItem),
      group: discoveredItem.group,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      badges: buildBadges(this.providerId, discoveredItem),
      isProviderManaged: true,
      validTransitions: [],
      hasActions: false,
      activityLog: [],
      relatedItems: [],
      isIncoming: true,
      providerId: this.providerId,
      externalId: this.externalId,
    };
  }

  private getHtml(initialItem: EditorItemData): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'webview-dist', 'editor.js'),
    ).toString();
    return getEditorPanelHtml({
      cspSource: this.panel.webview.cspSource,
      scriptUri,
      initialItem,
    });
  }

  private static cacheKey(providerId: string, externalId: string): string {
    return `${providerId}::${externalId}`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    IncomingPreviewPanel.openPanels.delete(IncomingPreviewPanel.cacheKey(this.providerId, this.externalId));
    for (const sub of this.subscriptions) {
      try { sub.dispose(); } catch { /* ignore */ }
    }
    this.subscriptions.length = 0;
    try { this.panel.dispose(); } catch { /* ignore */ }
  }
}
