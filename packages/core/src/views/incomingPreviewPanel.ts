import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { ProviderItem } from '../api/types';
import { logger } from '../services/logger';
import { ProviderRegistry } from '../services/providerRegistry';
import { buildRelatedItemsIndex, resolveRelatedItemsFor, type RelatedItemsIndex } from '../services/relatedItems';
import { WorkGraph } from '../services/workGraph';
import { InboxStateStore } from '../storage/inboxStateStore';
import { ReadStateStore } from '../storage/readStateStore';
import { isSafeUrl } from '../utils/url';
import { getProviderItemKey, parseProviderItemKey } from './providerItemKey';
import { getEditorPanelHtml, renderMarkdown } from './editorPanelHtml';
import type { EditorItemData } from './mainTypes';
import { composeEditorBadges } from './workItemEditorPanel';

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
  static readonly viewType = 'devdocket.previewItem';
  private static readonly openPanels = new Map<string, IncomingPreviewPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly providerRegistry: ProviderRegistry;
  private readonly stateStore: InboxStateStore;
  private readonly readStateStore: ReadStateStore;
  private readonly workGraph: WorkGraph;
  private readonly providerId: string;
  private readonly externalId: string;
  private readonly extensionUri: vscode.Uri;
  private readonly subscriptions: vscode.Disposable[] = [];
  private htmlInitialized = false;
  private disposed = false;
  private providerRefreshObserved = false;

  static createSerializer(
    context: vscode.ExtensionContext,
    providerRegistry: ProviderRegistry,
    stateStore: InboxStateStore,
    readStateStore: ReadStateStore,
    workGraph: WorkGraph,
  ): vscode.WebviewPanelSerializer {
    return {
      async deserializeWebviewPanel(panel, state): Promise<void> {
        const restoredState = parseIncomingPreviewPanelState(state);
        panel.webview.options = IncomingPreviewPanel.getWebviewOptions(context);
        if (!restoredState) {
          IncomingPreviewPanel.showUnavailable(panel, 'Incoming preview state is unavailable. Close this tab and reopen the item from DevDocket.');
          return;
        }

        IncomingPreviewPanel.revive(
          context,
          providerRegistry,
          stateStore,
          readStateStore,
          workGraph,
          panel,
          restoredState.providerId,
          restoredState.externalId,
        );
      },
    };
  }

  static open(
    context: vscode.ExtensionContext,
    providerRegistry: ProviderRegistry,
    stateStore: InboxStateStore,
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

    const providerItem = providerRegistry
      .getProviderItems(providerId)
      .find(item => item.externalId === externalId);
    if (!providerItem) {
      void vscode.window.showWarningMessage('Item is no longer available from the provider.');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      IncomingPreviewPanel.viewType,
      `Preview: ${providerItem.title}`,
      vscode.ViewColumn.One,
      {
        ...IncomingPreviewPanel.getWebviewOptions(context),
        retainContextWhenHidden: true,
      },
    );

    const preview = new IncomingPreviewPanel(panel, providerRegistry, stateStore, readStateStore, workGraph, providerId, externalId, context.extensionUri, false);
    IncomingPreviewPanel.openPanels.set(key, preview);
    // Panel cleanup is wired in the constructor via panel.onDidDispose →
    // this.dispose(). Pushing onto context.subscriptions would leak a
    // closure per open (panels self-dispose long before the extension does).
  }

  private static revive(
    context: vscode.ExtensionContext,
    providerRegistry: ProviderRegistry,
    stateStore: InboxStateStore,
    readStateStore: ReadStateStore,
    workGraph: WorkGraph,
    panel: vscode.WebviewPanel,
    providerId: string,
    externalId: string,
  ): void {
    const key = IncomingPreviewPanel.cacheKey(providerId, externalId);
    const existing = IncomingPreviewPanel.openPanels.get(key);
    if (existing) {
      existing.dispose();
    }

    panel.webview.options = IncomingPreviewPanel.getWebviewOptions(context);
    const preview = new IncomingPreviewPanel(panel, providerRegistry, stateStore, readStateStore, workGraph, providerId, externalId, context.extensionUri, true);
    IncomingPreviewPanel.openPanels.set(key, preview);
  }

  private static getWebviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview-dist')],
    };
  }

  private static showUnavailable(panel: vscode.WebviewPanel, message: string): void {
    panel.title = 'Incoming preview unavailable';
    panel.webview.html = getUnavailableHtml('Incoming preview unavailable', message);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    providerRegistry: ProviderRegistry,
    stateStore: InboxStateStore,
    readStateStore: ReadStateStore,
    workGraph: WorkGraph,
    providerId: string,
    externalId: string,
    extensionUri: vscode.Uri,
    private readonly restoredFromSerializer: boolean,
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
      this.providerRegistry.onDidChangeProviderItems(() => this.update()),
      this.providerRegistry.onDidRegisterProvider(() => this.update()),
      this.providerRegistry.onDidRefreshProvider((providerId) => {
        if (providerId === this.providerId) {
          this.providerRefreshObserved = true;
          this.update();
        }
      }),
      this.stateStore.onDidChange(() => this.checkInboxState()),
      this.panel.webview.onDidReceiveMessage((msg) => {
        void this.handleMessage(msg);
      }),
    );

    this.panel.onDidDispose(() => this.dispose());
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    const message = msg as { type?: string; url?: string; text?: string; itemId?: string; providerId?: string; externalId?: string };

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
      case 'openItem':
        if (typeof message.itemId === 'string') {
          await this.openRelatedItem(message.itemId, message.providerId, message.externalId);
        }
        break;
      // Autosave, transitions, and runAction are no-ops in preview mode.
      default:
        break;
    }
  }

  private async openRelatedItem(itemId: string, providerId?: unknown, externalId?: unknown): Promise<void> {
    const workItem = this.workGraph.getItem(itemId);
    if (workItem) {
      await vscode.commands.executeCommand('devdocket.editItem', { id: itemId });
      return;
    }

    const discoveredKey = typeof providerId === 'string' && typeof externalId === 'string'
      ? { providerId, externalId }
      : parseProviderItemKey(itemId);
    if (discoveredKey) {
      await vscode.commands.executeCommand('devdocket.previewIncomingItem', discoveredKey);
    }
  }

  private async acceptAndOpen(): Promise<void> {
    try {
      const providerItem = this.findProviderItem();
      if (!providerItem) {
        void vscode.window.showWarningMessage('Item is no longer available from the provider.');
        return;
      }

      let existing = this.workGraph.findItemByProvenance(this.providerId, this.externalId);
      if (!existing) {
        await this.workGraph.createItem(
          { title: providerItem.title, description: providerItem.description },
          {
            providerId: this.providerId,
            externalId: this.externalId,
            itemType: providerItem.itemType,
            url: providerItem.url,
            ...(providerItem.group ? { group: providerItem.group } : {}),
          },
        );
        existing = this.workGraph.findItemByProvenance(this.providerId, this.externalId);
      }

      await this.stateStore.setState(this.providerId, this.externalId, 'accepted');

      if (!existing) {
        // createItem succeeded above (no throw) but findItemByProvenance still
        // returns nothing — almost certainly a concurrent dispose() of the work
        // graph. Surface this so the user knows the click did something even
        // though no editor opened.
        logger.warn(`IncomingPreview: WorkItem missing after accept (${this.providerId}/${this.externalId})`);
        void vscode.window.showErrorMessage('Item was accepted but the editor could not be opened. Try selecting it from DevDocket.');
        this.dispose();
        return;
      }

      await vscode.commands.executeCommand('devdocket.editItem', { id: existing.id });
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
    const providerItem = this.findProviderItem();
    if (!providerItem) {
      if (this.restoredFromSerializer) {
        this.showPendingRestore();
        return;
      }
      // The provider no longer surfaces this item; close the preview.
      this.dispose();
      return;
    }

    const relatedItemsIndex = buildRelatedItemsIndex(this.providerRegistry, this.workGraph);
    const editorItem = this.buildEditorItemData(providerItem, relatedItemsIndex);
    this.panel.title = `Preview: ${providerItem.title}`;

    if (!this.htmlInitialized) {
      this.panel.webview.html = this.getHtml(editorItem);
      this.htmlInitialized = true;
      // Mark as seen so the unread indicator clears once the user opens the
      // preview. Persistence failures aren't user-actionable from here, but
      // log them so a stuck unread dot is diagnosable from the output channel.
      const discoveredKey = getProviderItemKey(this.providerId, this.externalId);
      void this.readStateStore.add(discoveredKey).catch(err => {
        logger.warn(`DevDocket: failed to mark ${discoveredKey} as seen`, err);
      });
      return;
    }

    void this.panel.webview.postMessage({ type: 'updateEditorItem', item: editorItem });
  }

  private showPendingRestore(): void {
    this.htmlInitialized = false;
    const providerMissing = !this.providerRegistry.getProvider(this.providerId) && !this.providerRegistry.loading;
    const unavailable = this.providerRefreshObserved || providerMissing;
    this.panel.title = unavailable ? 'Preview unavailable' : 'Preview: Loading…';
    const message = this.providerRefreshObserved
      ? 'This incoming item was not found after the provider refreshed. It may have been completed, dismissed, or removed.'
      : providerMissing
        ? 'The provider for this incoming item is not registered. If the provider extension is still loading, this preview will restore after its items refresh.'
        : 'Loading incoming item from provider…';
    this.panel.webview.html = getStatePreservingHtml(
      message,
      { version: 1, providerId: this.providerId, externalId: this.externalId },
    );
  }

  private findProviderItem(): ProviderItem | undefined {
    return this.providerRegistry
      .getProviderItems(this.providerId)
      .find(item => item.externalId === this.externalId);
  }

  private buildEditorItemData(providerItem: ProviderItem, relatedItemsIndex: RelatedItemsIndex): EditorItemData {
    const providerLabel = this.providerRegistry.getProviderLabel(this.providerId);
    return {
      id: getProviderItemKey(this.providerId, this.externalId),
      title: providerItem.title,
      notes: undefined,
      url: providerItem.url,
      description: providerItem.description ? renderMarkdown(providerItem.description) : undefined,
      state: 'New',
      providerLabel,
      group: providerItem.group,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      badges: composeEditorBadges(this.providerId, providerItem, this.providerRegistry.getProviderLabel(this.providerId)),
      isProviderManaged: true,
      validTransitions: [],
      hasActions: false,
      activityLog: [],
      relatedItems: resolveRelatedItemsFor(
        { providerId: this.providerId, externalId: this.externalId, itemType: providerItem.itemType },
        this.providerRegistry,
        this.workGraph,
        relatedItemsIndex,
      ),
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
    return getProviderItemKey(providerId, externalId);
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

interface IncomingPreviewPanelState {
  providerId: string;
  externalId: string;
}

function parseIncomingPreviewPanelState(state: unknown): IncomingPreviewPanelState | undefined {
  if (!state || typeof state !== 'object') {
    return undefined;
  }
  const candidate = state as { version?: unknown; providerId?: unknown; externalId?: unknown };
  if (candidate.version !== undefined && candidate.version !== 1) {
    return undefined;
  }
  if (typeof candidate.providerId !== 'string' || candidate.providerId.length === 0) {
    return undefined;
  }
  if (typeof candidate.externalId !== 'string' || candidate.externalId.length === 0) {
    return undefined;
  }
  return { providerId: candidate.providerId, externalId: candidate.externalId };
}

function getUnavailableHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none';">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function getStatePreservingHtml(message: string, state: unknown): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Incoming preview</title>
  <style nonce="${nonce}">
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 16px; }
  </style>
</head>
<body>
  <p>${escapeHtml(message)}</p>
  <script nonce="${nonce}">
    window.__DEVDOCKET_VSCODE_API__ = window.__DEVDOCKET_VSCODE_API__ || acquireVsCodeApi();
    window.__DEVDOCKET_VSCODE_API__.setState(${serializeForScript(state)});
  </script>
</body>
</html>`;
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

