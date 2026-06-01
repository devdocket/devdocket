import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { buildRelatedItemsIndex, type RelatedItemsIndex } from '../services/relatedItems';
import { getInboxUnseenCount } from '../services/inboxBadge';
import { ProviderRegistry } from '../services/providerRegistry';
import { WatcherService } from '../services/watcherService';
import { WorkGraph } from '../services/workGraph';
import { InboxStateStore } from '../storage/inboxStateStore';
import { ReadStateStore } from '../storage/readStateStore';
import { buildTierColorCss } from '../webview/shared/colors';
import type { GitWorkResolverRegistry } from '../services/gitWorkResolverRegistry';
import type { ProviderItem } from '../api/types';
import type { CIBadgeLookup } from './ciBadgeLookup';
import { buildCIBadgeLookup } from './ciBadgeLookup';
import type { SourceProviderData, TierData, WebviewMessage } from './mainTypes';
import { buildSourcesData } from './sourcesSnapshotBuilder';
import { buildTierData } from './tierSnapshotBuilder';
import { MainWebviewMessageHandler } from './webviewMessageHandler';

export { computeCIBadge } from './ciBadgeLookup';

export type RefreshReason =
  | 'workGraph'
  | 'discovered'
  | 'health'
  | 'state'
  | 'watchedRuns'
  | 'watchedPRs'
  | 'readState';

export class MainViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'devdocket.main';
  private static readonly REFRESH_DEBOUNCE_MS = 50;
  private static readonly WEBVIEW_READY_TIMEOUT_MS = 3000;

  private view?: vscode.WebviewView;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private webviewReadyTimer?: ReturnType<typeof setTimeout>;
  private pendingRefreshReasons = new Set<RefreshReason>();
  private webviewReady = false;
  private disposed = false;
  private readonly messageHandler: MainWebviewMessageHandler;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workGraph: WorkGraph,
    private readonly providerRegistry: ProviderRegistry,
    private readonly stateStore: InboxStateStore,
    private readonly readStateStore: ReadStateStore,
    private readonly watcherService: WatcherService,
    private readonly gitWorkResolverRegistry?: GitWorkResolverRegistry,
  ) {
    this.messageHandler = new MainWebviewMessageHandler({
      workGraph: this.workGraph,
      providerRegistry: this.providerRegistry,
      stateStore: this.stateStore,
      readStateStore: this.readStateStore,
      getCurrentTiers: () => this.buildCurrentTierData(),
      onWebviewReady: () => this.handleWebviewReady(),
      toggleSearch: () => this.toggleSearch(),
    });
  }

  /**
   * Cancel any pending debounced refresh and stop accepting new ones. The
   * webview view itself is owned by VS Code and is disposed independently.
   */
  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.webviewReadyTimer) {
      clearTimeout(this.webviewReadyTimer);
      this.webviewReadyTimer = undefined;
    }
    this.pendingRefreshReasons.clear();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    this.webviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview-dist')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.messageHandler.handleMessage(message);
    });

    if (this.webviewReadyTimer) {
      clearTimeout(this.webviewReadyTimer);
    }
    this.webviewReadyTimer = setTimeout(() => {
      if (!this.webviewReady && this.view === webviewView && !this.disposed) {
        this.handleWebviewReady();
      }
      this.webviewReadyTimer = undefined;
    }, MainViewProvider.WEBVIEW_READY_TIMEOUT_MS);

    this.scheduleRefresh('discovered');
  }

  scheduleRefresh(reason: RefreshReason): void {
    if (this.disposed) {
      return;
    }
    this.pendingRefreshReasons.add(reason);
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      const reasons = new Set(this.pendingRefreshReasons);
      this.pendingRefreshReasons.clear();
      this.refreshTimer = undefined;
      this.refresh(reasons);
    }, MainViewProvider.REFRESH_DEBOUNCE_MS);
  }

  selectItem(itemId: string): void {
    void this.view?.webview.postMessage({ type: 'selectItem', itemId });
  }

  toggleSearch(): void {
    void this.view?.webview.postMessage({ type: 'toggleSearch' });
  }

  private handleWebviewReady(): void {
    this.webviewReady = true;
    if (this.webviewReadyTimer) {
      clearTimeout(this.webviewReadyTimer);
      this.webviewReadyTimer = undefined;
    }
    this.scheduleRefresh('discovered');
  }

  private refresh(reasons: ReadonlySet<RefreshReason>): void {
    if (!this.view) {
      return;
    }
    if (!this.webviewReady) {
      // The ready/fallback paths call scheduleRefresh('discovered') to re-arm
      // the debounce timer and flush these buffered reasons once delivery is safe.
      for (const reason of reasons) {
        this.pendingRefreshReasons.add(reason);
      }
      return;
    }

    const allProviderItems = this.providerRegistry.getAllProviderItems();
    const relatedItemsIndex = this.buildRelatedItemsIndex(allProviderItems);
    const ciBadgeLookup = this.buildCIBadgeLookup(allProviderItems);

    // My Work renders unread markers, tier state/order, related-item markers, and CI badges.
    void this.view.webview.postMessage({
      type: 'updateItems',
      tiers: this.buildTierSnapshot(allProviderItems, relatedItemsIndex, ciBadgeLookup),
    });
    if (this.shouldRefreshSources(reasons)) {
      void this.view.webview.postMessage({
        type: 'updateSources',
        providers: this.buildSourcesSnapshot(allProviderItems, relatedItemsIndex, ciBadgeLookup),
      });
    }
    this.updateBadge();
  }

  private shouldRefreshSources(reasons: ReadonlySet<RefreshReason>): boolean {
    // Sources render provider health, inbox-state marks, related-item markers, and CI badges.
    return reasons.has('discovered')
      || reasons.has('health')
      || reasons.has('state')
      || reasons.has('workGraph')
      || reasons.has('watchedRuns')
      || reasons.has('watchedPRs');
  }

  /** Update the activity-bar badge with the unread incoming count. */
  private updateBadge(): void {
    if (!this.view) {
      return;
    }
    const count = getInboxUnseenCount(this.providerRegistry, this.stateStore, new Set(this.readStateStore.keys()));
    if (count > 0) {
      this.view.badge = {
        value: count,
        tooltip: `${count} unread incoming item${count === 1 ? '' : 's'}`,
      };
    } else {
      this.view.badge = undefined;
    }
  }

  private buildCurrentTierData(): TierData[] {
    const allProviderItems = this.providerRegistry.getAllProviderItems();
    return this.buildTierSnapshot(
      allProviderItems,
      this.buildRelatedItemsIndex(allProviderItems),
      this.buildCIBadgeLookup(allProviderItems),
    );
  }

  private buildRelatedItemsIndex(allProviderItems: ReadonlyMap<string, readonly ProviderItem[]>): RelatedItemsIndex {
    return buildRelatedItemsIndex(this.providerRegistry, this.workGraph, allProviderItems);
  }

  private buildCIBadgeLookup(allProviderItems: ReadonlyMap<string, readonly ProviderItem[]>): CIBadgeLookup {
    return buildCIBadgeLookup(this.workGraph.getAll(), allProviderItems, this.watcherService);
  }

  private buildTierSnapshot(
    allProviderItems: ReadonlyMap<string, readonly ProviderItem[]>,
    relatedItemsIndex: RelatedItemsIndex,
    ciBadgeLookup: CIBadgeLookup,
  ): TierData[] {
    return buildTierData({
      allProviderItems,
      getInboxState: (providerId, externalId) => this.stateStore.getState(providerId, externalId),
      hasRead: key => this.readStateStore.has(key),
      getProviderLabel: providerId => this.providerRegistry.getProviderLabel(providerId),
      getItemsByState: (...states) => this.workGraph.getItemsByState(...states),
      findItemByProvenance: (providerId, externalId) => this.workGraph.findItemByProvenance(providerId, externalId),
      relatedItemsIndex,
      ciBadgeLookup,
      gitWorkResolverRegistry: this.gitWorkResolverRegistry,
    });
  }

  private buildSourcesSnapshot(
    allProviderItems: ReadonlyMap<string, readonly ProviderItem[]>,
    relatedItemsIndex: RelatedItemsIndex,
    ciBadgeLookup: CIBadgeLookup,
  ): SourceProviderData[] {
    return buildSourcesData({
      allProviderItems,
      getInboxState: (providerId, externalId) => this.stateStore.getState(providerId, externalId),
      getProviderLabel: providerId => this.providerRegistry.getProviderLabel(providerId),
      getProviderHealth: providerId => this.providerRegistry.getProviderHealth(providerId),
      relatedItemsIndex,
      ciBadgeLookup,
    });
  }
  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview-dist', 'sidebar.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>DevDocket</title>
  <style nonce="${nonce}">
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
      align-items: stretch;
      gap: 4px;
      border-bottom: 1px solid var(--vscode-widget-border);
      flex-shrink: 0;
      padding-right: 8px;
    }
    .tab-list {
      display: flex;
      flex: 1;
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
    .tab:focus-visible,
    .tab-action:focus-visible {
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
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .my-work-tab,
    .sources-tab {
      padding: 12px;
    }
    .search-box {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 8px 0;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
    }
    .search-box-input-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }
    .search-box input {
      width: 100%;
      min-width: 0;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      padding: 4px 28px 4px 6px;
      font: inherit;
    }
    .search-box input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .search-box input::-webkit-search-cancel-button,
    .search-box input::-webkit-search-decoration,
    .search-box input::-webkit-search-results-button,
    .search-box input::-webkit-search-results-decoration {
      -webkit-appearance: none;
      appearance: none;
    }
    .search-box-clear {
      position: absolute;
      right: 4px;
      background: transparent;
      color: var(--vscode-icon-foreground);
      border: none;
      cursor: pointer;
      padding: 2px 6px;
      font: inherit;
      line-height: 1;
    }
    .search-box-clear:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.25));
    }
    .search-box-clear:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    mark {
      background: var(--vscode-editor-findMatchHighlightBackground);
      color: inherit;
      border-radius: 2px;
    }
    .tiers,
    .sources-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .tier-section {
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      padding: 10px 6px;
    }
    .tier-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tier-header-main,
    .tier-toggle-button,
    .tier-header-action {
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 0;
      font: inherit;
    }
    .tier-header-main {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
      text-align: left;
    }
    .tier-header-action {
      color: var(--vscode-textLink-foreground, var(--vscode-foreground));
    }
    .tier-header-action:hover {
      text-decoration: underline;
    }
    .tier-header-action:disabled,
    .tier-header-action[aria-disabled="true"] {
      color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
      cursor: default;
      opacity: 0.65;
    }
    .tier-header-action:disabled:hover,
    .tier-header-action[aria-disabled="true"]:hover {
      text-decoration: none;
    }
    .tier-toggle-button {
      display: inline-flex;
      align-items: center;
    }
    .tier-header-main[aria-disabled="true"],
    .tier-toggle-button[aria-disabled="true"] {
      cursor: default;
    }
    .tier-header-main:focus-visible,
    .tier-toggle-button:focus-visible,
    .tier-header-action:focus-visible,
    .source-provider-toggle-button:focus-visible,
    .source-group-header:focus-visible,
    .source-item:focus-visible,
    .item-action-btn:focus-visible,
    .onboarding-empty-state-button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .item-card:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .tier-count,
    .tier-toggle {
      color: var(--vscode-descriptionForeground);
    }
    .tier-items {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
    }
    .tier-items.drag-active {
      border-radius: 6px;
      outline: 1px dashed var(--vscode-focusBorder);
      outline-offset: 4px;
    }
    .source-provider,
    .source-group {
      border-left: 3px solid transparent;
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      padding: 10px 12px;
    }
    .source-provider {
      border-left-color: var(--vscode-textLink-foreground);
    }
    .source-provider.unhealthy {
      border-left-color: var(--vscode-problemsWarningIcon-foreground, var(--vscode-editorWarning-foreground));
    }
    .source-provider-header {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .source-group-header,
    .source-provider-toggle-button,
    .health-warning-button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 0;
      text-align: left;
      font: inherit;
    }
    .source-group-header {
      width: 100%;
    }
    .source-provider-title-button {
      min-width: 0;
    }
    .source-provider-toggle-button[aria-disabled="true"],
    .source-group-header[aria-disabled="true"] {
      cursor: default;
    }
    .source-provider-title,
    .source-group-title {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }
    .source-provider-meta,
    .source-group-meta {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-descriptionForeground);
    }
    .source-provider-toggle,
    .source-group-toggle {
      color: var(--vscode-descriptionForeground);
    }
    .source-provider-groups,
    .source-group-items {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
    }
    .source-item {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 12px;
      border: none;
      border-left: 3px solid transparent;
      border-radius: 6px;
      background: var(--vscode-list-inactiveSelectionBackground, rgba(127, 127, 127, 0.08));
      color: inherit;
      cursor: pointer;
      text-align: left;
      font: inherit;
    }
    .source-item.accepted {
      border-left-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    }
    .source-item.dismissed {
      opacity: 0.65;
    }
    .source-item:disabled {
      cursor: default;
    }
    .source-item:hover:not(:disabled) {
      background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.12));
    }
    .source-item-line {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .source-item-title-wrap {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }
    .source-item-title {
      font-weight: 600;
      word-break: break-word;
    }
    .source-item-status {
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .source-item-status.accepted-mark {
      color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
      font-weight: 600;
    }
    .source-empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .health-warning-button {
      line-height: inherit;
    }
    .health-warning-button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
      border-radius: 2px;
    }
    .onboarding-empty-state {
      max-width: 360px;
      margin: 32px auto;
      padding: 24px 16px;
      text-align: center;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.24));
      border-radius: 8px;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    }
    .onboarding-empty-state-title {
      margin: 0 0 8px;
      font-size: 14px;
      font-weight: 600;
    }
    .onboarding-empty-state-description {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }
    .onboarding-empty-state-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
      margin-top: 16px;
    }
    .onboarding-empty-state-button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 2px;
      padding: 4px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font: inherit;
    }
    .onboarding-empty-state-button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .onboarding-empty-state-button-secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    .onboarding-empty-state-button-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
    }
    .health-warning {
      color: var(--vscode-problemsWarningIcon-foreground, var(--vscode-editorWarning-foreground));
    }
    .item-card {
      position: relative;
      width: 100%;
      border: none;
      border-left: 3px solid transparent;
      border-radius: 6px;
      background: var(--vscode-list-inactiveSelectionBackground, rgba(127, 127, 127, 0.08));
      cursor: pointer;
    }
    .item-card[draggable="true"] {
      cursor: grab;
    }
    .item-card.dragging {
      opacity: 0.4;
    }
    .item-card-main {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 12px;
      background: transparent;
      border: none;
      color: inherit;
      cursor: inherit;
      text-align: left;
      font: inherit;
    }
    .item-card.dragging,
    .item-card.dragging .item-card-main,
    .item-card.dragging .drag-handle {
      cursor: grabbing;
    }
    .item-card.item-card--incoming { border-left-color: var(--tier-incoming); }
    .item-card.item-card--in-progress { border-left-color: var(--tier-in-progress); }
    .item-card.item-card--ready-to-start { border-left-color: var(--tier-ready); }
    .item-card.item-card--paused { border-left-color: var(--tier-paused); }
    .item-card.item-card--done { border-left-color: var(--tier-done); }
    .item-card.urgent { border-left-color: var(--tier-urgent); }
    .item-card.selected {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 0;
    }
    .item-card.multi-selected {
      background: var(--vscode-list-activeSelectionBackground, rgba(64, 128, 255, 0.2));
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 0;
    }
    .item-card.multi-selected:hover,
    .item-card.multi-selected:focus-within {
      background: var(--vscode-list-activeSelectionBackground, rgba(64, 128, 255, 0.25));
    }
    .bulk-action-bar {
      position: sticky;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 12px;
      margin: 8px -8px 0;
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      border-top: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, transparent));
      box-shadow: 0 -2px 6px rgba(0, 0, 0, 0.2);
      z-index: 5;
      flex-wrap: wrap;
    }
    .bulk-action-count {
      font-weight: 600;
    }
    .bulk-action-buttons {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .bulk-action-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, transparent));
      border-radius: 4px;
      cursor: pointer;
      font: inherit;
    }
    .bulk-action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
    }
    .bulk-action-btn.bulk-action-clear {
      padding: 4px 8px;
    }
    .item-card:hover,
    .item-card:focus-within {
      background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.12));
    }
    .item-actions {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      gap: 6px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s;
      padding: 4px 6px;
      border-radius: 6px;
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, transparent));
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
    }
    .item-card:hover .item-actions,
    .item-card.actions-open .item-actions {
      opacity: 1;
      pointer-events: auto;
    }
    .item-action-btn {
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      border-radius: 4px;
      padding: 4px 9px;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
    }
    .item-action-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.25));
    }
    .item-action-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .item-line-1 {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .item-title-wrap {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }
    .drag-handle {
      position: absolute;
      left: 2px;
      top: 50%;
      transform: translateY(-50%);
      opacity: 0;
      pointer-events: none;
      cursor: grab;
      color: var(--vscode-foreground);
      user-select: none;
      line-height: 1;
      font-size: 18px;
      padding: 4px 6px;
      border-radius: 6px;
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, transparent));
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
      transition: opacity 0.15s;
    }
    .item-card:hover .drag-handle,
    .item-card:focus-within .drag-handle,
    .item-card.dragging .drag-handle {
      opacity: 1;
      pointer-events: auto;
    }
    .drop-indicator {
      height: 2px;
      background: var(--vscode-focusBorder);
      margin: 0 8px;
      border-radius: 1px;
    }
    .item-title {
      font-weight: 600;
      word-break: break-word;
    }
    .item-repo-annotation {
      font-weight: 400;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      opacity: 0.75;
      word-break: break-all;
    }
    .unseen-dot {
      color: var(--tier-incoming);
      line-height: 1.2;
    }
    .related-indicator {
      color: var(--vscode-descriptionForeground);
      line-height: 1.2;
      flex-shrink: 0;
    }
    .git-work-indicator {
      color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-descriptionForeground));
      line-height: 1.2;
      flex-shrink: 0;
      font-size: 12px;
    }
    .git-work-indicator--stale {
      color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground));
      opacity: 0.75;
    }
    .badge-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .badge-pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.4;
    }
    .badge-pill--clickable {
      cursor: pointer;
    }
    .badge-pill--clickable:hover,
    .badge-pill--clickable:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
      filter: brightness(1.08);
    }
    .badge-pill--fallback {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.3));
      font-weight: 400;
    }
    .empty-state, .placeholder {
      padding: 16px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      font-style: italic;
    }
    .empty-state-link {
      background: transparent;
      border: none;
      color: var(--vscode-textLink-foreground, var(--vscode-foreground));
      cursor: pointer;
      font: inherit;
      font-style: inherit;
      padding: 0;
    }
    .empty-state-link:hover {
      text-decoration: underline;
    }
    .empty-state-link:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    :root {
      ${buildTierColorCss('dark')}
    }
    body.vscode-light {
      ${buildTierColorCss('light')}
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }}

function getNonce(): string {
  // Cryptographically random nonce (matches editorPanelHtml). Math.random
  // is seeded per-process and predictable, which would make CSP a paper
  // shield if any future change introduced user-controlled HTML.
  return crypto.randomBytes(16).toString('hex');
}