import * as vscode from 'vscode';
import type { DiscoveredItem } from '../api/types';
import { WorkItem, WorkItemInput, WorkItemState } from '../models/workItem';
import { ActionRegistry } from '../services/actionRegistry';
import { ProviderRegistry } from '../services/providerRegistry';
import { VALID_TRANSITIONS, WorkGraph } from '../services/workGraph';
import type { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { isSafeUrl } from '../utils/url';
import { buildProviderBadge, buildProviderBadges, buildTypeBadge } from './badges';
import { getEditorPanelHtml, renderMarkdown } from './editorPanelHtml';
import type { BadgeData, EditorItemData } from './mainTypes';

interface AutosaveData {
  title?: string;
  notes?: string;
  url?: string;
}

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
  private static actionRegistry?: ActionRegistry;
  private static stateStore?: DiscoveredStateStore;

  private readonly panel: vscode.WebviewPanel;
  private readonly workGraph: WorkGraph;
  private readonly providerRegistry: ProviderRegistry;
  private readonly itemId: string;
  private readonly panelManager: PanelManager;
  private readonly extensionUri: vscode.Uri;
  private disposed = false;
  private htmlInitialized = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingData: AutosaveData | undefined;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly messageSubscription: vscode.Disposable;
  private readonly workGraphSub: vscode.Disposable;
  private readonly providerRegSub: vscode.Disposable;
  private readonly providerChangeSub: vscode.Disposable;
  private readonly actionRegistrySub?: vscode.Disposable;
  private lastDisplayedTitle: string | undefined;
  private lastDisplayedUrl: string | undefined;
  private lastDisplayedDescription: string | undefined;
  private lastDisplayedNotes: string | undefined;
  private lastDisplayedState: WorkItemState | undefined;
  private lastDisplayedGroup: string | undefined;
  private lastManagedState: boolean | undefined;

  /**
   * Replace the active panel manager. Called during `activate()` to scope
   * the panel cache to the extension lifecycle.
   */
  static setPanelManager(manager: PanelManager): void {
    WorkItemEditorPanel.panelManager = manager;
  }

  static setDependencies(actionRegistry?: ActionRegistry, stateStore?: DiscoveredStateStore): void {
    WorkItemEditorPanel.actionRegistry = actionRegistry;
    WorkItemEditorPanel.stateStore = stateStore;
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
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview-dist')],
      },
    );

    const editor = new WorkItemEditorPanel(panel, workGraph, providerRegistry, item.id, manager, context.extensionUri, providerLabel);
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
    extensionUri: vscode.Uri,
    private providerLabel?: string,
  ) {
    this.panel = panel;
    this.workGraph = workGraph;
    this.providerRegistry = providerRegistry;
    this.itemId = itemId;
    this.panelManager = panelManager;
    this.extensionUri = extensionUri;

    this.update();

    this.workGraphSub = this.workGraph.onDidChange(() => {
      this.checkForWorkItemUpdates();
    });

    this.providerRegSub = this.providerRegistry.onDidRegisterProvider(() => {
      this.update();
    });

    this.providerChangeSub = this.providerRegistry.onDidChangeDiscoveredItems(() => {
      this.update();
    });

    this.actionRegistrySub = WorkItemEditorPanel.actionRegistry?.onDidChangeRegistrations(() => {
      this.update();
    });

    this.messageSubscription = this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'openItem' && typeof msg.itemId === 'string') {
        void vscode.commands.executeCommand('devdocket.editItem', { id: msg.itemId });
        return;
      }
      if (msg?.type === 'openUrl' && typeof msg.url === 'string') {
        const safeUrl = isSafeUrl(msg.url);
        if (safeUrl) {
          void vscode.env.openExternal(vscode.Uri.parse(safeUrl.href));
        }
        return;
      }
      if (msg?.type === 'copyToClipboard' && typeof msg.text === 'string') {
        void vscode.env.clipboard.writeText(msg.text);
        return;
      }
      if (msg?.type === 'transitionState' && typeof msg.itemId === 'string' && typeof msg.targetState === 'string') {
        void this.handleTransitionState(msg.itemId, msg.targetState);
        return;
      }
      if (msg?.type === 'runAction' && typeof msg.itemId === 'string') {
        void vscode.commands.executeCommand('devdocket.runAction', { id: msg.itemId });
        return;
      }
      if (msg?.type === 'acceptItem' && typeof msg.providerId === 'string' && typeof msg.externalId === 'string') {
        void this.handleAcceptItem(msg.providerId, msg.externalId);
        return;
      }
      if (msg?.type === 'dismissItem' && typeof msg.providerId === 'string' && typeof msg.externalId === 'string') {
        void this.handleDismissItem(msg.providerId, msg.externalId);
        return;
      }
      if (msg?.type === 'autosave' && msg.data && typeof msg.data === 'object') {
        this.pendingData = msg.data as AutosaveData;
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
        this.actionRegistrySub?.dispose();
      }
    });
  }

  private isProviderManaged(item: WorkItem): boolean {
    return !!(item.providerId && this.providerRegistry.getProvider(item.providerId));
  }

  /**
   * Respond to WorkGraph changes. When the persisted title changes (e.g. from
   * a provider title sync), push the new title to the webview without replacing
   * the local editor model so unsaved notes drafts are preserved.
   */
  private checkForWorkItemUpdates(): void {
    if (this.disposed) { return; }
    const item = this.workGraph.getItem(this.itemId);
    if (!item) {
      this.update();
      return;
    }

    const currentManaged = this.isProviderManaged(item);
    if (currentManaged !== this.lastManagedState) {
      this.update();
      return;
    }

    const titleChanged = item.title !== this.lastDisplayedTitle;
    const nonTitleChanges = item.url !== this.lastDisplayedUrl
      || item.description !== this.lastDisplayedDescription
      || item.notes !== this.lastDisplayedNotes
      || item.state !== this.lastDisplayedState
      || item.group !== this.lastDisplayedGroup;

    if (titleChanged && !nonTitleChanges) {
      this.lastDisplayedTitle = item.title;
      this.panel.title = `Edit: ${item.title}`;
      void this.panel.webview.postMessage({ type: 'updateTitle', title: item.title });
      return;
    }

    if (titleChanged || nonTitleChanges) {
      this.update();
    }
  }

  private async saveData(data: AutosaveData): Promise<void> {
    const item = this.workGraph.getItem(this.itemId);
    if (!item) {
      throw new Error('Work item no longer exists. Your changes could not be saved.');
    }
    const managed = this.isProviderManaged(item);
    const patch: Partial<WorkItemInput> = {};

    if (!managed) {
      const title = data.title?.trim() ?? '';
      if (!title) {
        return;
      }
      patch.title = title;

      if ('url' in data) {
        const rawUrl = data.url?.trim() ?? '';
        if (rawUrl === '') {
          patch.url = undefined;
        } else {
          const safe = isSafeUrl(rawUrl);
          if (safe) {
            patch.url = safe.href;
          }
        }
      }
    }

    if ('notes' in data) {
      patch.notes = data.notes?.trim() || undefined;
    }

    if (Object.keys(patch).length === 0) {
      return;
    }

    await this.workGraph.updateItem(this.itemId, patch);
  }

  private update(): void {
    const item = this.workGraph.getItem(this.itemId);
    if (!item) {
      this.htmlInitialized = false;
      this.panel.webview.html = '<html><body><p>Item not found.</p></body></html>';
      return;
    }

    const editorItem = this.buildEditorItemData(item);
    this.lastDisplayedTitle = item.title;
    this.lastDisplayedUrl = item.url;
    this.lastDisplayedDescription = item.description;
    this.lastDisplayedNotes = item.notes;
    this.lastDisplayedState = item.state;
    this.lastDisplayedGroup = item.group;
    this.lastManagedState = editorItem.isProviderManaged;
    this.panel.title = `Edit: ${item.title}`;

    if (!this.htmlInitialized) {
      this.panel.webview.html = this.getHtml(editorItem);
      this.htmlInitialized = true;
      return;
    }

    void this.panel.webview.postMessage({ type: 'updateEditorItem', item: editorItem });
  }

  private buildEditorItemData(item: WorkItem): EditorItemData {
    const discoveredItem = this.getDiscoveredItem(item);
    const providerLabel = item.providerId ? this.providerLabel ?? this.providerRegistry.getProviderLabel(item.providerId) : undefined;

    return {
      id: item.id,
      title: item.title,
      notes: item.notes,
      url: item.url,
      description: item.description ? renderMarkdown(item.description) : undefined,
      state: item.state,
      providerLabel,
      group: item.group,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      badges: composeEditorBadges(item.providerId, discoveredItem, providerLabel),
      isProviderManaged: this.isProviderManaged(item),
      validTransitions: Array.from(VALID_TRANSITIONS.get(item.state) ?? []),
      hasActions: WorkItemEditorPanel.actionRegistry?.hasActionsFor(item) ?? false,
      activityLog: item.activityLog ?? [],
      relatedItems: this.buildRelatedItems(item, discoveredItem),
      isIncoming: false,
      providerId: item.providerId,
      externalId: item.externalId,
    };
  }

  private buildRelatedItems(item: WorkItem, discoveredItem?: DiscoveredItem): EditorItemData['relatedItems'] {
    if (!discoveredItem?.canonicalId) {
      return [];
    }

    const relatedItems = new Map<string, EditorItemData['relatedItems'][number]>();
    for (const [providerId, items] of this.providerRegistry.getAllDiscoveredItems()) {
      for (const candidate of items) {
        if (candidate.canonicalId !== discoveredItem.canonicalId) {
          continue;
        }
        if (providerId === item.providerId && candidate.externalId === item.externalId) {
          continue;
        }

        const peer = this.workGraph.findItemByProvenance(providerId, candidate.externalId);
        if (!peer || peer.id === item.id) {
          continue;
        }

        relatedItems.set(peer.id, {
          id: peer.id,
          title: peer.title,
          state: peer.state,
          badges: composeEditorBadges(providerId, candidate, this.providerRegistry.getProviderLabel(providerId)),
        });
      }
    }

    return Array.from(relatedItems.values()).sort((left, right) => left.title.localeCompare(right.title));
  }

  private getDiscoveredItem(item: WorkItem): DiscoveredItem | undefined {
    if (!item.providerId || !item.externalId) {
      return undefined;
    }

    return this.providerRegistry
      .getDiscoveredItems(item.providerId)
      .find(discovered => discovered.externalId === item.externalId);
  }

  private getHtml(item: EditorItemData): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'webview-dist', 'editor.js'),
    ).toString();

    return getEditorPanelHtml({
      cspSource: this.panel.webview.cspSource,
      scriptUri,
      initialItem: item,
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
      this.actionRegistrySub?.dispose();
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

  private enqueueSave(data: AutosaveData): void {
    this.saveQueue = this.saveQueue.then(async () => {
      try {
        await this.saveData(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to save work item: ${message}`);
      }
    });
  }

  private async handleTransitionState(itemId: string, targetState: string): Promise<void> {
    try {
      await this.workGraph.transitionState(itemId, targetState as WorkItemState);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to transition work item: ${message}`);
    }
  }

  private async handleAcceptItem(providerId: string, externalId: string): Promise<void> {
    const stateStore = WorkItemEditorPanel.stateStore;
    if (!stateStore) {
      return;
    }

    try {
      const existing = this.workGraph.findItemByProvenance(providerId, externalId);
      if (!existing) {
        const discoveredItem = this.providerRegistry.getDiscoveredItems(providerId).find(item => item.externalId === externalId);
        if (!discoveredItem) {
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
      await stateStore.setState(providerId, externalId, 'accepted');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to accept item: ${message}`);
    }
  }

  private async handleDismissItem(providerId: string, externalId: string): Promise<void> {
    const stateStore = WorkItemEditorPanel.stateStore;
    if (!stateStore) {
      return;
    }

    try {
      await stateStore.setState(providerId, externalId, 'dismissed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to dismiss item: ${message}`);
    }
  }
}

/**
 * Compose the badge list shown in the editor: provider, type, then the
 * provider-supplied badges declared on the {@link DiscoveredItem}. CI badges
 * are not added here — the editor doesn't currently surface CI status inline.
 */
export function composeEditorBadges(
  providerId?: string,
  discoveredItem?: DiscoveredItem,
  providerLabel?: string,
): BadgeData[] {
  const badges: BadgeData[] = [];
  // providerLabel is passed through to buildProviderBadge so third-party
  // providers get a real name on the badge instead of being mislabeled
  // as "Manual".
  const providerBadge = buildProviderBadge(providerId, providerLabel);
  if (providerBadge) badges.push(providerBadge);
  const typeBadge = buildTypeBadge(discoveredItem);
  if (typeBadge) badges.push(typeBadge);
  badges.push(...buildProviderBadges(discoveredItem, 'editor'));
  return badges;
}
