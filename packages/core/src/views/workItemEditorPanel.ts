import * as vscode from 'vscode';
import { WorkItem, WorkItemInput } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import { getEditorPanelHtml } from './editorPanelHtml';
import { isSafeUrl } from '../utils/url';

export class WorkItemEditorPanel {
  private static readonly viewType = 'devdocket.editItem';
  private static readonly openPanels = new Map<string, WorkItemEditorPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly workGraph: WorkGraph;
  private readonly providerRegistry: ProviderRegistry;
  private readonly itemId: string;
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingData: Record<string, string> | undefined;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly messageSubscription: vscode.Disposable;
  private readonly discoveredItemsSub: vscode.Disposable;
  private lastResolvedTitle: string | undefined;
  private lastManagedState: boolean | undefined;

  static open(
    context: vscode.ExtensionContext,
    workGraph: WorkGraph,
    providerRegistry: ProviderRegistry,
    item: WorkItem,
    providerLabel?: string,
  ): void {
    const existing = WorkItemEditorPanel.openPanels.get(item.id);
    if (existing) {
      existing.providerLabel = providerLabel;
      existing.update();
      existing.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      WorkItemEditorPanel.viewType,
      `Edit: ${item.title}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const editor = new WorkItemEditorPanel(panel, workGraph, providerRegistry, item.id, providerLabel);
    WorkItemEditorPanel.openPanels.set(item.id, editor);
    context.subscriptions.push({ dispose: () => editor.dispose() });
  }

  /** @internal Exposed for testing only. */
  static clearPanelCache(): void {
    const panels = Array.from(WorkItemEditorPanel.openPanels.values());
    for (const editor of panels) {
      editor.dispose();
    }
    WorkItemEditorPanel.openPanels.clear();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    workGraph: WorkGraph,
    providerRegistry: ProviderRegistry,
    itemId: string,
    private providerLabel?: string,
  ) {
    this.panel = panel;
    this.workGraph = workGraph;
    this.providerRegistry = providerRegistry;
    this.itemId = itemId;

    this.update();

    this.discoveredItemsSub = this.providerRegistry.onDidChangeDiscoveredItems(() => {
      this.checkTitleUpdate();
    });

    this.messageSubscription = this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'openUrl' && typeof msg.url === 'string') {
        const safeUrl = isSafeUrl(msg.url);
        if (safeUrl) {
          void vscode.env.openExternal(vscode.Uri.parse(safeUrl.href));
        }
        return;
      }
      if (msg?.type === 'autosave' && msg.data && typeof msg.data === 'object') {
        this.pendingData = msg.data;
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = undefined;
          const data = this.pendingData;
          this.pendingData = undefined;
          if (!data) {
            return;
          }
          this.enqueueSave(data);
        }, 300);
      }
    });

    this.panel.onDidDispose(() => {
      if (!this.disposed) {
        this.disposed = true;
        WorkItemEditorPanel.openPanels.delete(this.itemId);
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = undefined;
        }
        this.flushPendingData();
        this.messageSubscription.dispose();
        this.discoveredItemsSub.dispose();
      }
    });
  }

  private isProviderManaged(item: WorkItem): boolean {
    return !!(item.providerId && this.providerRegistry.getProvider(item.providerId));
  }

  /**
   * Resolve the display title for the work item. For provider-backed items,
   * returns the live title from the provider when available; otherwise falls
   * back to the persisted title.
   */
  private resolveTitle(item: WorkItem): string {
    if (item.providerId && item.externalId) {
      const discovered = this.providerRegistry
        .getDiscoveredItems(item.providerId)
        .find((d) => d.externalId === item.externalId);
      if (discovered) {
        return discovered.title;
      }
    }
    return item.title;
  }

  /**
   * Check whether the live provider title or managed state has changed.
   * A managed-state change (provider registered/unregistered while panel is
   * open) requires a full re-render to toggle the title input's readonly
   * state. A title-only change uses a targeted postMessage to avoid losing
   * unsaved notes edits.
   */
  private checkTitleUpdate(): void {
    if (this.disposed) { return; }
    const item = this.workGraph.getItem(this.itemId);
    if (!item) { return; }

    const currentManaged = this.isProviderManaged(item);
    if (currentManaged !== this.lastManagedState) {
      this.update();
      return;
    }

    if (!item.providerId || !item.externalId) { return; }

    const newTitle = this.resolveTitle(item);
    if (newTitle !== this.lastResolvedTitle) {
      this.lastResolvedTitle = newTitle;
      this.panel.title = `Edit: ${newTitle}`;
      void this.panel.webview.postMessage({ type: 'updateTitle', title: newTitle });
    }
  }

  private async saveData(data: Record<string, string>): Promise<void> {
    const item = this.workGraph.getItem(this.itemId);
    if (!item) {
      throw new Error('Work item no longer exists. Your changes could not be saved.');
    }
    const managed = this.isProviderManaged(item);
    const patch: Partial<WorkItemInput> = {};

    if (!managed) {
      if (!data.title) {
        return;
      }
      patch.title = data.title;
    }

    if ('notes' in data) {
      patch.notes = data.notes || undefined;
    }

    if (Object.keys(patch).length === 0) {
      return;
    }

    await this.workGraph.updateItem(this.itemId, patch);
    if (!this.disposed && data.title && !managed) {
      this.panel.title = `Edit: ${data.title}`;
    }
  }

  private update(): void {
    const item = this.workGraph.getItem(this.itemId);
    if (!item) {
      this.panel.webview.html = '<html><body><p>Item not found.</p></body></html>';
      return;
    }
    const resolvedTitle = this.resolveTitle(item);
    this.lastResolvedTitle = resolvedTitle;
    this.lastManagedState = this.isProviderManaged(item);
    this.panel.title = `Edit: ${resolvedTitle}`;
    this.panel.webview.html = this.getHtml(item, resolvedTitle);
  }

  private getHtml(item: WorkItem, displayTitle: string): string {
    let providerDescription: string | undefined;
    let providerState: string | undefined;
    if (item.providerId && item.externalId) {
      const discovered = this.providerRegistry
        .getDiscoveredItems(item.providerId)
        .find((d) => d.externalId === item.externalId);
      providerDescription = discovered?.description ?? undefined;
      providerState = discovered?.state ?? undefined;
    }
    return getEditorPanelHtml({
      cspSource: this.panel.webview.cspSource,
      item,
      providerLabel: this.providerLabel,
      providerDescription,
      providerState,
      titleReadonly: this.isProviderManaged(item),
      displayTitle,
    });
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      WorkItemEditorPanel.openPanels.delete(this.itemId);
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = undefined;
      }
      this.flushPendingData();
      this.messageSubscription.dispose();
      this.discoveredItemsSub.dispose();
      this.panel.dispose();
    }
  }

  private flushPendingData(): void {
    const data = this.pendingData;
    this.pendingData = undefined;
    if (data) {
      this.enqueueSave(data);
    }
  }

  private enqueueSave(data: Record<string, string>): void {
    this.saveQueue = this.saveQueue.then(async () => {
      try {
        await this.saveData(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to save work item: ${message}`);
      }
    });
  }

}
