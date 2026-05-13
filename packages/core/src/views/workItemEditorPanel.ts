import * as vscode from 'vscode';
import type { ProviderItem } from '../api/types';
import { WorkItem, WorkItemInput, WorkItemState } from '../models/workItem';
import { ActionRegistry } from '../services/actionRegistry';
import { ProviderRegistry } from '../services/providerRegistry';
import { buildRelatedItemsIndex, resolveRelatedItemsFor, type RelatedItemsIndex } from '../services/relatedItems';
import { VALID_TRANSITIONS, WorkGraph } from '../services/workGraph';
import type { WatcherService, WatchedPR, WatchedRun } from '../services/watcherService';
import type { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { isSafeUrl } from '../utils/url';
import { buildProviderBadge, buildProviderBadges, buildTypeBadge } from './badges';
import { parseProviderItemKey } from './providerItemKey';
import { getEditorPanelHtml, renderMarkdown } from './editorPanelHtml';
import type { BadgeData, EditorItemData } from './mainTypes';

interface AutosaveData {
  title?: string;
  notes?: string;
  url?: string;
}

interface EditorCIWatchContext {
  watch: WatchedPR;
  watchKey: string;
  runs: WatchedRun[];
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
  private static watcherService?: WatcherService;

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
  private readonly watcherSubscriptions: vscode.Disposable[] = [];
  private lastDisplayedTitle: string | undefined;
  private lastDisplayedUrl: string | undefined;
  private lastDisplayedDescription: string | undefined;
  private lastDisplayedNotes: string | undefined;
  private lastDisplayedState: WorkItemState | undefined;
  private lastDisplayedGroup: string | undefined;
  private lastManagedState: boolean | undefined;
  private lastDisplayedCIWatchSignature: string | undefined;
  private lastDisplayedCIWatchRunKeys = new Set<string>();

  /**
   * Replace the active panel manager. Called during `activate()` to scope
   * the panel cache to the extension lifecycle.
   */
  static setPanelManager(manager: PanelManager): void {
    WorkItemEditorPanel.panelManager = manager;
  }

  static setDependencies(actionRegistry?: ActionRegistry, stateStore?: DiscoveredStateStore, watcherService?: WatcherService): void {
    WorkItemEditorPanel.actionRegistry = actionRegistry;
    WorkItemEditorPanel.stateStore = stateStore;
    WorkItemEditorPanel.watcherService = watcherService;
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

    this.providerChangeSub = this.providerRegistry.onDidChangeProviderItems(() => {
      this.update();
    });

    this.actionRegistrySub = WorkItemEditorPanel.actionRegistry?.onDidChangeRegistrations(() => {
      this.update();
    });

    const watcherService = WorkItemEditorPanel.watcherService;
    if (watcherService) {
      this.watcherSubscriptions.push(
        watcherService.onDidChangePRWatches(() => this.refreshForPRWatchChange()),
        watcherService.onDidChangeWatchedRuns(runs => this.refreshForWatchedRunsChange(runs)),
      );
    }

    this.messageSubscription = this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'openItem' && typeof msg.itemId === 'string') {
        void this.handleOpenItem(msg.itemId, msg.providerId, msg.externalId);
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
      if (msg?.type === 'openWatches') {
        void vscode.commands.executeCommand('devdocket.showWatchesQuickPick');
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
        this.disposeWatcherSubscriptions();
      }
    });
  }

  private isProviderManaged(item: WorkItem): boolean {
    return !!(item.providerId && this.providerRegistry.getProvider(item.providerId));
  }

  private refreshForPRWatchChange(): void {
    if (this.disposed) { return; }
    const item = this.workGraph.getItem(this.itemId);
    if (!isPRWorkItem(item)) { return; }

    if (this.buildCIWatchSignature(item) !== this.lastDisplayedCIWatchSignature) {
      this.update();
    }
  }

  private refreshForWatchedRunsChange(changedRuns: WatchedRun[]): void {
    if (this.disposed) { return; }
    const item = this.workGraph.getItem(this.itemId);
    if (!isPRWorkItem(item)) { return; }

    const context = this.getCIWatchContext(item);
    const currentRunKeys = new Set(context?.runs.map(run => getRunWatchKey(run.identifier)) ?? []);
    const changedRunTouchesCurrentWatch = changedRuns.some(run => {
      const runKey = getRunWatchKey(run.identifier);
      return run.parentPRKey === context?.watchKey
        || context?.watch.childRunKeys.includes(runKey) === true
        || this.lastDisplayedCIWatchRunKeys.has(runKey)
        || currentRunKeys.has(runKey);
    });
    const childRunSetChanged = !setsEqual(currentRunKeys, this.lastDisplayedCIWatchRunKeys);
    if (!changedRunTouchesCurrentWatch && !childRunSetChanged) {
      return;
    }

    if (this.buildCIWatchSignature(item, context) !== this.lastDisplayedCIWatchSignature) {
      this.update();
    }
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
      this.lastDisplayedCIWatchSignature = undefined;
      this.lastDisplayedCIWatchRunKeys.clear();
      this.panel.webview.html = '<html><body><p>Item not found.</p></body></html>';
      return;
    }

    const relatedItemsIndex = buildRelatedItemsIndex(this.providerRegistry, this.workGraph);
    const editorItem = this.buildEditorItemData(item, relatedItemsIndex);
    this.rememberDisplayedCIWatchState(item);
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

  private buildEditorItemData(item: WorkItem, relatedItemsIndex: RelatedItemsIndex): EditorItemData {
    const providerItem = this.getProviderItem(item);
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
      badges: composeEditorBadges(item.providerId, providerItem, providerLabel),
      isProviderManaged: this.isProviderManaged(item),
      validTransitions: Array.from(VALID_TRANSITIONS.get(item.state) ?? []),
      hasActions: WorkItemEditorPanel.actionRegistry?.hasActionsFor(item) ?? false,
      activityLog: item.activityLog ?? [],
      relatedItems: resolveRelatedItemsFor(item, this.providerRegistry, this.workGraph, relatedItemsIndex),
      ciWatch: this.buildCIWatchData(item),
      isIncoming: false,
      providerId: item.providerId,
      externalId: item.externalId,
    };
  }

  private async handleOpenItem(itemId: string, providerId?: unknown, externalId?: unknown): Promise<void> {
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

  private getProviderItem(item: WorkItem): ProviderItem | undefined {
    if (!item.providerId || !item.externalId) {
      return undefined;
    }

    return this.providerRegistry.findProviderItem(item.providerId, item.externalId);
  }

  private buildCIWatchData(item: WorkItem): EditorItemData['ciWatch'] {
    const context = this.getCIWatchContext(item);
    if (!context) {
      return undefined;
    }

    return {
      state: context.watch.prState,
      runs: context.runs.map(run => ({
        id: getRunWatchKey(run.identifier),
        name: run.identifier.displayName,
        state: toEditorRunState(run.status.overallState),
        ...(run.status.conclusion ? { conclusion: run.status.conclusion } : {}),
        ...(run.hasWarning ? { hasWarning: true } : {}),
      })),
      totalActive: context.runs.filter(run => run.status.overallState !== 'completed' && !run.dismissed).length,
      totalFailing: context.runs.filter(isFailingOrWarningRun).length,
    };
  }

  private getCIWatchContext(item: WorkItem): EditorCIWatchContext | undefined {
    if (!isPRWorkItem(item)) {
      return undefined;
    }

    const watcherService = WorkItemEditorPanel.watcherService;
    const external = item.externalId ? parsePRExternalId(item.externalId) : undefined;
    if (!watcherService || !external) {
      return undefined;
    }

    const watch = watcherService.findPRWatchByExternalId(external.repo, external.prId);
    if (!watch) {
      return undefined;
    }

    const watchKey = watcherService.getPRWatchKey(watch.identifier);
    return {
      watch,
      watchKey,
      runs: watcherService.getChildRuns(watchKey),
    };
  }

  private rememberDisplayedCIWatchState(item: WorkItem): void {
    const context = this.getCIWatchContext(item);
    this.lastDisplayedCIWatchSignature = this.buildCIWatchSignature(item, context);
    this.lastDisplayedCIWatchRunKeys = new Set(context?.runs.map(run => getRunWatchKey(run.identifier)) ?? []);
  }

  private buildCIWatchSignature(item: WorkItem, context = this.getCIWatchContext(item)): string | undefined {
    if (!context) {
      return undefined;
    }

    const runSignatures = context.runs
      .map(run => [
        getRunWatchKey(run.identifier),
        run.status.overallState,
        run.status.conclusion ?? '',
        run.hasWarning ? 'warning' : '',
      ].join(':'))
      .sort();
    return [context.watchKey, context.watch.prState, ...runSignatures].join('|');
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
      this.disposeWatcherSubscriptions();
      this.panel.dispose();
    }
  }

  private disposeWatcherSubscriptions(): void {
    while (this.watcherSubscriptions.length > 0) {
      this.watcherSubscriptions.pop()?.dispose();
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
        const providerItem = this.providerRegistry.getProviderItems(providerId).find(item => item.externalId === externalId);
        if (!providerItem) {
          return;
        }
        await this.workGraph.createItem(
          {
            title: providerItem.title,
            description: providerItem.description,
          },
          {
            providerId,
            externalId,
            itemType: providerItem.itemType,
            url: providerItem.url,
            ...(providerItem.group ? { group: providerItem.group } : {}),
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

function isPRWorkItem(item: WorkItem | undefined): item is WorkItem & { itemType: 'pr' } {
  return item?.itemType === 'pr';
}

function parsePRExternalId(externalId: string): { repo: string; prId: string } | undefined {
  const separatorIndex = externalId.lastIndexOf('#');
  if (separatorIndex <= 0 || separatorIndex === externalId.length - 1) {
    return undefined;
  }
  return {
    repo: externalId.slice(0, separatorIndex),
    prId: externalId.slice(separatorIndex + 1),
  };
}

function getRunWatchKey(identifier: WatchedRun['identifier']): string {
  return identifier.repo
    ? `${identifier.providerId}:${identifier.repo}:${identifier.runId}`
    : `${identifier.providerId}:${identifier.runId}`;
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function toEditorRunState(state: WatchedRun['status']['overallState']): NonNullable<EditorItemData['ciWatch']>['runs'][number]['state'] {
  return state === 'running' ? 'in_progress' : state;
}

function isFailingOrWarningRun(run: WatchedRun): boolean {
  if (run.hasWarning) return true;
  if (run.status.overallState !== 'completed') return false;
  const conclusion = run.status.conclusion;
  if (conclusion === undefined || conclusion === 'success') return false;
  return conclusion !== 'cancelled' && conclusion !== 'skipped' && conclusion !== 'neutral';
}

/**
 * Compose the badge list shown in the editor: provider, type, then the
 * provider-supplied badges declared on the {@link ProviderItem}. CI badges
 * are not added here — the editor surfaces active watch details in its
 * dedicated CI Watch section instead.
 */
export function composeEditorBadges(
  providerId?: string,
  providerItem?: ProviderItem,
  providerLabel?: string,
): BadgeData[] {
  const badges: BadgeData[] = [];
  // providerLabel is passed through to buildProviderBadge so third-party
  // providers get a real name on the badge instead of being mislabeled
  // as "Manual".
  const providerBadge = buildProviderBadge(providerId, providerLabel);
  if (providerBadge) badges.push(providerBadge);
  const typeBadge = buildTypeBadge(providerItem);
  if (typeBadge) badges.push(typeBadge);
  badges.push(...buildProviderBadges(providerItem, 'editor'));
  return badges;
}
