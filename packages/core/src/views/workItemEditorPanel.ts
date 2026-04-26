import * as vscode from 'vscode';
import { WorkItem, WorkItemInput } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import { getEditorPanelHtml } from './editorPanelHtml';
import { isSafeUrl } from '../utils/url';

/**
 * Manages the lifecycle of open WorkItemEditorPanels.
 * Created during extension activation and disposed with the extension context,
 * preventing stale panel references across extension reloads.
 */
export class PanelManager {
  /** @internal Used by WorkItemEditorPanel — not part of public API. */
  readonly openPanels = new Map<string, WorkItemEditorPanel>();
  private disposed = false;

  /** Dispose all tracked panels and clear the cache. */
  clearPanelCache(): void {
    const panels = Array.from(this.openPanels.values());
    for (const editor of panels) {
      editor.dispose();
    }
    this.openPanels.clear();
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.clearPanelCache();
  }
}

export class WorkItemEditorPanel {
  private static readonly viewType = 'devdocket.editItem';
  private static panelManager = new PanelManager();
  private readonly panel: vscode.WebviewPanel;
  private readonly workGraph: WorkGraph;
  private readonly providerRegistry: ProviderRegistry;
  private readonly itemId: string;
  private readonly panelManager: PanelManager;
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingData: Record<string, string> | undefined;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly messageSubscription: vscode.Disposable;
  private readonly workGraphSub: vscode.Disposable;
  private readonly providerRegSub: vscode.Disposable;
  private readonly providerChangeSub: vscode.Disposable;
  private lastDisplayedTitle: string | undefined;
  private lastDisplayedUrl: string | undefined;
  private lastManagedState: boolean | undefined;

  /**
   * Replace the active panel manager. Called during `activate()` to scope
   * the panel cache to the extension lifecycle.
   */
  static setPanelManager(manager: PanelManager): void {
    WorkItemEditorPanel.panelManager = manager;
  }

  static open(
    context: vscode.ExtensionContext,
    workGraph: WorkGraph,
    providerRegistry: ProviderRegistry,
    item: WorkItem,
    providerLabel?: string,
  ): void {
    const manager = WorkItemEditorPanel.panelManager;
    const existing = manager.openPanels.get(item.id);
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

    const editor = new WorkItemEditorPanel(panel, workGraph, providerRegistry, item.id, manager, providerLabel);
    manager.openPanels.set(item.id, editor);
    context.subscriptions.push({ dispose: () => editor.dispose() });
  }

  /** @internal Exposed for testing only. */
  static clearPanelCache(): void {
    WorkItemEditorPanel.panelManager.clearPanelCache();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    workGraph: WorkGraph,
    providerRegistry: ProviderRegistry,
    itemId: string,
    panelManager: PanelManager,
    private providerLabel?: string,
  ) {
    this.panel = panel;
    this.workGraph = workGraph;
    this.providerRegistry = providerRegistry;
    this.itemId = itemId;
    this.panelManager = panelManager;

    this.update();

    this.workGraphSub = this.workGraph.onDidChange(() => {
      this.checkForUpdates();
    });

    this.providerRegSub = this.providerRegistry.onDidRegisterProvider(() => {
      this.checkForUpdates();
    });

    this.providerChangeSub = this.providerRegistry.onDidChangeDiscoveredItems(() => {
      this.checkForUpdates();
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
        this.panelManager.openPanels.delete(this.itemId);
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = undefined;
        }
        this.flushPendingData();
        this.messageSubscription.dispose();
        this.workGraphSub.dispose();
        this.providerRegSub.dispose();
        this.providerChangeSub.dispose();
      }
    });
  }

  private isProviderManaged(item: WorkItem): boolean {
    return !!(item.providerId && this.providerRegistry.getProvider(item.providerId));
  }

  /**
   * Respond to WorkGraph changes. When the persisted title changes (e.g. from
   * a provider title sync), push the new title to the webview without a full
   * re-render to preserve unsaved notes edits. When the managed state changes
   * (provider registered/unregistered), do a full re-render to toggle the
   * title input's readonly state.
   */
  private checkForUpdates(): void {
    if (this.disposed) { return; }
    const item = this.workGraph.getItem(this.itemId);
    if (!item) { return; }

    const currentManaged = this.isProviderManaged(item);
    if (currentManaged !== this.lastManagedState) {
      this.update();
      return;
    }

    if (item.title !== this.lastDisplayedTitle) {
      this.lastDisplayedTitle = item.title;
      this.panel.title = `Edit: ${item.title}`;
      void this.panel.webview.postMessage({ type: 'updateTitle', title: item.title });
    }

    // Re-render when URL changes to keep the title hyperlink and URL field in sync
    if (item.url !== this.lastDisplayedUrl) {
      this.update();
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

      if ('url' in data) {
        const rawUrl = data.url || '';
        // Allow clearing the URL; validate non-empty values
        if (rawUrl === '') {
          patch.url = undefined;
        } else {
          const safe = isSafeUrl(rawUrl);
          if (safe) {
            patch.url = safe.href;
          }
          // Silently ignore invalid URLs
        }
      }
    }

    if ('notes' in data) {
      patch.notes = data.notes || undefined;
    }

    if (Object.keys(patch).length === 0) {
      return;
    }

    // Pre-sync tracked URL before updateItem fires onDidChange synchronously,
    // preventing a self-triggered full re-render that could wipe unsaved edits.
    if ('url' in patch) {
      this.lastDisplayedUrl = patch.url;
    }

    await this.workGraph.updateItem(this.itemId, patch);
  }

  private update(): void {
    const item = this.workGraph.getItem(this.itemId);
    if (!item) {
      this.panel.webview.html = '<html><body><p>Item not found.</p></body></html>';
      return;
    }
    this.lastDisplayedTitle = item.title;
    this.lastDisplayedUrl = item.url;
    this.lastManagedState = this.isProviderManaged(item);
    this.panel.title = `Edit: ${item.title}`;
    this.panel.webview.html = this.getHtml(item);
  }

  private getHtml(item: WorkItem): string {
    let providerDescription: string | undefined;
    let providerState: string | undefined;
    if (item.providerId && item.externalId) {
      const discovered = this.providerRegistry
        .getDiscoveredItems(item.providerId)
        .find((d) => d.externalId === item.externalId);
      providerState = discovered?.state ?? undefined;
    }
    // Use the synced description from the persisted WorkItem
    providerDescription = item.description;
    return getEditorPanelHtml({
      cspSource: this.panel.webview.cspSource,
      item,
      providerLabel: this.providerLabel,
      providerDescription,
      providerState,
      titleReadonly: this.isProviderManaged(item),
    });
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.panelManager.openPanels.delete(this.itemId);
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = undefined;
      }
      this.flushPendingData();
      this.messageSubscription.dispose();
      this.workGraphSub.dispose();
      this.providerRegSub.dispose();
      this.providerChangeSub.dispose();
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
