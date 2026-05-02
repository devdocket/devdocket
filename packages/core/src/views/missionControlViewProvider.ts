import * as vscode from 'vscode';
import type { DiscoveredItem } from '../api/types';
import { type WorkItem, WorkItemState } from '../models/workItem';
import { ActionRegistry } from '../services/actionRegistry';
import { buildCanonicalHiddenSet } from '../services/canonicalDedup';
import { logger } from '../services/logger';
import { ProviderRegistry } from '../services/providerRegistry';
import { WatcherService, type WatchedPR, type WatchedRun } from '../services/watcherService';
import { WorkGraph } from '../services/workGraph';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { ReadStateStore } from '../storage/readStateStore';
import { isSafeUrl } from '../utils/url';
import { buildTierColorCss } from '../webview/shared/colors';
import type {
  BadgeData,
  ItemCardData,
  SourceGroupData,
  SourceItemData,
  SourceProviderData,
  TierData,
  WebviewMessage,
} from './missionControlTypes';

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
      tiers: this.buildTierData(),
    });
    void this.view.webview.postMessage({
      type: 'updateSources',
      providers: this.buildSourcesData(),
    });
  }

  private buildTierData(): TierData[] {
    const allDiscoveredItems = this.providerRegistry.getAllDiscoveredItems();
    const hiddenCanonicalKeys = buildCanonicalHiddenSet(
      allDiscoveredItems,
      (providerId, externalId) => this.stateStore.getState(providerId, externalId),
    );
    const discoveredItemMap = this.buildDiscoveredItemMap(allDiscoveredItems);

    const incomingItems: ItemCardData[] = [];
    for (const [providerId, items] of allDiscoveredItems) {
      for (const discoveredItem of items) {
        const inboxState = this.stateStore.getState(providerId, discoveredItem.externalId);
        if (inboxState !== undefined && inboxState !== 'unseen') {
          continue;
        }

        const key = getDiscoveredItemKey(providerId, discoveredItem.externalId);
        if (hiddenCanonicalKeys.has(key)) {
          continue;
        }

        incomingItems.push(
          this.buildIncomingCardData(
            providerId,
            discoveredItem,
            this.workGraph.findItemByProvenance(providerId, discoveredItem.externalId),
          ),
        );
      }
    }
    incomingItems.reverse();

    const inProgressItems = this.workGraph
      .getItemsByState(WorkItemState.InProgress)
      .sort((a, b) => this.compareUrgencyThenUpdated(a, b, discoveredItemMap))
      .map(item => this.buildWorkItemCardData(item, 'inProgress', discoveredItemMap));

    const readyToStartItems = this.workGraph
      .getItemsByState(WorkItemState.New)
      .sort((a, b) => this.compareUrgency(a, b, discoveredItemMap)
        || (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
        || b.updatedAt - a.updatedAt)
      .map(item => this.buildWorkItemCardData(item, 'readyToStart', discoveredItemMap));

    const pausedItems = this.workGraph
      .getItemsByState(WorkItemState.Paused)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map(item => this.buildWorkItemCardData(item, 'paused', discoveredItemMap));

    const doneItems = this.workGraph
      .getItemsByState(WorkItemState.Done, WorkItemState.Archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(item => this.buildWorkItemCardData(item, 'done', discoveredItemMap));

    return [
      { id: 'incoming', name: 'Incoming', icon: '↓', items: incomingItems, collapsed: false },
      { id: 'in-progress', name: 'In Progress', icon: '▶', items: inProgressItems, collapsed: false },
      { id: 'ready-to-start', name: 'Ready to Start', icon: '○', items: readyToStartItems, collapsed: false },
      { id: 'paused', name: 'Paused', icon: '⏸', items: pausedItems, collapsed: false },
      { id: 'done', name: 'Done', icon: '✓', items: doneItems, collapsed: true },
    ].filter(tier => tier.items.length > 0);
  }

  private buildSourcesData(): SourceProviderData[] {
    return Array.from(this.providerRegistry.getAllDiscoveredItems())
      .map(([providerId, items]) => {
        const groups = new Map<string, SourceItemData[]>();

        for (const item of items) {
          const groupName = item.group?.trim() || 'Ungrouped';
          const state = this.stateStore.getState(providerId, item.externalId);
          const groupItems = groups.get(groupName) ?? [];
          groupItems.push({
            externalId: item.externalId,
            providerId,
            title: item.title,
            badges: this.buildBadges(providerId, item, item.url),
            isAccepted: state === 'accepted',
            isDismissed: state === 'dismissed',
          });
          groups.set(groupName, groupItems);
        }

        const sortedGroups: SourceGroupData[] = Array.from(groups.entries())
          .map(([name, groupItems]) => ({
            name,
            items: groupItems.sort((a, b) => a.title.localeCompare(b.title)),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        return {
          providerId,
          label: this.providerRegistry.getProviderLabel(providerId),
          isHealthy: this.providerRegistry.getProviderHealth(providerId).status !== 'unhealthy',
          groups: sortedGroups,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  private buildDiscoveredItemMap(allDiscoveredItems: Iterable<[string, readonly DiscoveredItem[]]>): Map<string, DiscoveredItem> {
    const discoveredItemMap = new Map<string, DiscoveredItem>();
    for (const [providerId, items] of allDiscoveredItems) {
      for (const item of items) {
        discoveredItemMap.set(getDiscoveredItemKey(providerId, item.externalId), item);
      }
    }
    return discoveredItemMap;
  }

  private compareUrgency(a: WorkItem, b: WorkItem, discoveredItemMap: Map<string, DiscoveredItem>): number {
    const aUrgent = this.isUrgentWorkItem(a, discoveredItemMap);
    const bUrgent = this.isUrgentWorkItem(b, discoveredItemMap);
    if (aUrgent === bUrgent) {
      return 0;
    }
    return aUrgent ? -1 : 1;
  }

  private compareUrgencyThenUpdated(a: WorkItem, b: WorkItem, discoveredItemMap: Map<string, DiscoveredItem>): number {
    const urgency = this.compareUrgency(a, b, discoveredItemMap);
    if (urgency !== 0) {
      return urgency;
    }
    return b.updatedAt - a.updatedAt;
  }

  private isUrgentWorkItem(item: WorkItem, discoveredItemMap: Map<string, DiscoveredItem>): boolean {
    return this.isUrgentDiscoveredItem(this.getDiscoveredItemForWorkItem(item, discoveredItemMap));
  }

  private isUrgentDiscoveredItem(discoveredItem?: DiscoveredItem): boolean {
    return normalizeText(discoveredItem?.state) === 'changes requested';
  }

  private getDiscoveredItemForWorkItem(item: WorkItem, discoveredItemMap: Map<string, DiscoveredItem>): DiscoveredItem | undefined {
    if (!item.providerId || !item.externalId) {
      return undefined;
    }
    return discoveredItemMap.get(getDiscoveredItemKey(item.providerId, item.externalId));
  }

  private buildIncomingCardData(providerId: string, discoveredItem: DiscoveredItem, existingWorkItem?: WorkItem): ItemCardData {
    const workContext = existingWorkItem ? extractWorkContext(existingWorkItem) : {};
    return {
      id: existingWorkItem?.id ?? getDiscoveredItemKey(providerId, discoveredItem.externalId),
      title: discoveredItem.title,
      badges: this.buildBadges(providerId, discoveredItem, discoveredItem.url),
      branchName: workContext.branchName,
      repoName: workContext.repoName,
      tierType: 'incoming',
      isUnseen: true,
      isUrgent: this.isUrgentDiscoveredItem(discoveredItem),
      providerId,
      externalId: discoveredItem.externalId,
    };
  }

  private buildWorkItemCardData(
    item: WorkItem,
    tierType: ItemCardData['tierType'],
    discoveredItemMap: Map<string, DiscoveredItem>,
  ): ItemCardData {
    const discoveredItem = this.getDiscoveredItemForWorkItem(item, discoveredItemMap);
    const workContext = extractWorkContext(item);
    return {
      id: item.id,
      title: item.title,
      badges: this.buildBadges(item.providerId, discoveredItem, item.url),
      branchName: workContext.branchName,
      repoName: workContext.repoName,
      tierType,
      isUrgent: this.isUrgentWorkItem(item, discoveredItemMap),
      providerId: item.providerId,
      externalId: item.externalId,
    };
  }

  private buildBadges(providerId?: string, discoveredItem?: DiscoveredItem, itemUrl?: string): BadgeData[] {
    const badges: BadgeData[] = [];
    const providerBadge = this.buildProviderBadge(providerId);
    if (providerBadge) {
      badges.push(providerBadge);
    }

    const stateBadge = this.buildStateBadge(discoveredItem);
    if (stateBadge) {
      badges.push(stateBadge);
    }

    const ciBadge = this.buildCIBadge(discoveredItem?.url ?? itemUrl);
    if (ciBadge) {
      badges.push(ciBadge);
    }

    return badges;
  }

  private buildProviderBadge(providerId?: string): BadgeData | undefined {
    if (!providerId) {
      return undefined;
    }

    const normalizedProviderId = providerId.toLowerCase();
    if (normalizedProviderId.includes('github')) {
      return { label: 'GitHub', type: 'provider', variant: 'github' };
    }
    if (normalizedProviderId.includes('ado')) {
      return { label: 'ADO', type: 'provider', variant: 'ado' };
    }

    return { label: 'Manual', type: 'provider', variant: 'manual' };
  }

  private buildStateBadge(discoveredItem?: DiscoveredItem): BadgeData | undefined {
    if (!discoveredItem) {
      return undefined;
    }

    const normalizedReason = normalizeText(discoveredItem.reason);
    if (normalizedReason === 'review requested') {
      return { label: 'PR Review', type: 'state', variant: 'review-requested' };
    }

    const normalizedState = normalizeText(discoveredItem.state);
    switch (normalizedState) {
      case 'changes requested':
        return { label: 'Changes requested', type: 'state', variant: 'changes-requested' };
      case 'approved':
        return { label: 'Approved', type: 'state', variant: 'approved' };
      case 'draft':
        return { label: 'Draft', type: 'state', variant: 'draft' };
      case 'ready to merge':
        return { label: 'Ready to merge', type: 'state', variant: 'ready-to-merge' };
      case 'closed':
      case 'merged':
        return {
          label: discoveredItem.state?.trim() || toDisplayLabel(normalizedState),
          type: 'state',
          variant: 'closed',
        };
      case 'active':
      case 'open':
        return { label: 'Issue · open', type: 'state', variant: 'open' };
      case 'review received':
        return { label: 'Review received', type: 'state', variant: 'open' };
      case 'waiting on reviews':
        return { label: 'Waiting on reviews', type: 'state', variant: 'open' };
      default:
        return undefined;
    }
  }

  private buildCIBadge(url?: string): BadgeData | undefined {
    if (!url) {
      return undefined;
    }

    const watchedRun = this.watcherService
      .getActiveWatches()
      .find(runWatch => runWatch.identifier.url === url);
    if (watchedRun) {
      return this.getRunCIBadge(watchedRun);
    }

    const watchedPR = this.watcherService
      .getActivePRWatches()
      .find(prWatch => prWatch.identifier.url === url);
    if (watchedPR) {
      return this.getPRCIBadge(watchedPR);
    }

    return undefined;
  }

  private getRunCIBadge(watchedRun: WatchedRun): BadgeData {
    if (watchedRun.hasWarning || isFailedRun(watchedRun)) {
      return { label: 'CI failed', type: 'ci', variant: 'ci-fail' };
    }
    if (watchedRun.status.overallState !== 'completed') {
      return { label: 'CI running', type: 'ci', variant: 'ci-running' };
    }
    return { label: 'CI passed', type: 'ci', variant: 'ci-pass' };
  }

  private getPRCIBadge(watchedPR: WatchedPR): BadgeData | undefined {
    const childRuns = this.watcherService.getChildRuns(this.watcherService.getPRWatchKey(watchedPR.identifier));
    if (watchedPR.hasWarning || childRuns.some(runWatch => runWatch.hasWarning || isFailedRun(runWatch))) {
      return { label: 'CI failed', type: 'ci', variant: 'ci-fail' };
    }
    if (childRuns.some(runWatch => runWatch.status.overallState !== 'completed')) {
      return { label: 'CI running', type: 'ci', variant: 'ci-running' };
    }
    if (childRuns.length > 0 && childRuns.every(runWatch => runWatch.status.conclusion === 'success')) {
      return { label: 'CI passed', type: 'ci', variant: 'ci-pass' };
    }
    if (watchedPR.prState === 'open') {
      return { label: 'CI running', type: 'ci', variant: 'ci-running' };
    }
    return undefined;
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'openItem': {
        const workItem = this.workGraph.getItem(message.itemId);
        if (workItem) {
          await vscode.commands.executeCommand('devdocket.editItem', { id: message.itemId });
          break;
        }

        const discoveredKey = parseDiscoveredItemKey(message.itemId);
        if (discoveredKey) {
          const discoveredItem = this.providerRegistry
            .getDiscoveredItems(discoveredKey.providerId)
            .find(item => item.externalId === discoveredKey.externalId);
          if (discoveredItem?.url && isSafeUrl(discoveredItem.url)) {
            await vscode.env.openExternal(vscode.Uri.parse(discoveredItem.url));
          }
        }
        break;
      }
      case 'acceptItem':
        await this.handleAcceptItem(message.providerId, message.externalId);
        break;
      case 'acceptAll':
        await this.handleAcceptAll();
        break;
      case 'dismissItem':
        await this.handleDismissItem(message.providerId, message.externalId);
        break;
      case 'transitionState':
        await this.handleTransitionState(message.itemId, message.targetState);
        break;
      case 'reorderItems':
        await this.handleReorder(message.itemIds);
        break;
      case 'createItem':
        await vscode.commands.executeCommand('devdocket.createItem');
        break;
      case 'clearHistory':
        await vscode.commands.executeCommand('devdocket.clearHistory');
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

  private async handleAcceptAll(): Promise<void> {
    const incomingTier = this.buildTierData().find(tier => tier.id === 'incoming');
    if (!incomingTier) {
      return;
    }

    for (const item of incomingTier.items) {
      if (!item.providerId || !item.externalId) {
        continue;
      }

      await this.handleAcceptItem(item.providerId, item.externalId);
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

  private async handleReorder(itemIds: string[]): Promise<void> {
    try {
      if (itemIds.length < 2) {
        return;
      }

      const currentIds = this.workGraph
        .getItemsByState(WorkItemState.New)
        .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
          || b.updatedAt - a.updatedAt)
        .map(item => item.id);

      if (currentIds.length !== itemIds.length) {
        logger.warn('MissionControl: reorder ignored because ready-to-start items changed during drag');
        return;
      }

      const currentIdSet = new Set(currentIds);
      if (new Set(itemIds).size !== itemIds.length || currentIds.some(itemId => !itemIds.includes(itemId)) || itemIds.some(itemId => !currentIdSet.has(itemId))) {
        logger.warn('MissionControl: reorder ignored because it included unknown ready-to-start item ids');
        return;
      }

      if (itemIds.every((itemId, index) => itemId === currentIds[index])) {
        return;
      }

      const workingIds = [...currentIds];
      for (let index = 0; index < itemIds.length; index += 1) {
        const desiredId = itemIds[index];
        if (workingIds[index] === desiredId) {
          continue;
        }

        const draggedIndex = workingIds.indexOf(desiredId);
        if (draggedIndex === -1) {
          logger.warn(`MissionControl: reorder ignored because item ${desiredId} was not in the ready-to-start tier`);
          return;
        }

        if (index === workingIds.length - 1) {
          await this.workGraph.moveToEnd(desiredId);
        } else {
          await this.workGraph.reorderItem(desiredId, workingIds[index]);
        }

        workingIds.splice(draggedIndex, 1);
        workingIds.splice(index, 0, desiredId);
      }
    } catch (err) {
      logger.error('MissionControl: reorder failed', err);
      void vscode.window.showErrorMessage(`Failed to reorder items: ${err instanceof Error ? err.message : String(err)}`);
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
    .tab-action {
      align-self: center;
      padding: 4px 8px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
    }
    .tab-action:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.12));
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
    .tiers,
    .sources-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .tier-section {
      border-left: 3px solid transparent;
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      padding: 10px 12px;
    }
    .tier-section.tier-incoming { border-left-color: var(--tier-incoming); }
    .tier-section.tier-in-progress { border-left-color: var(--tier-in-progress); }
    .tier-section.tier-ready-to-start { border-left-color: var(--tier-ready); }
    .tier-section.tier-paused { border-left-color: var(--tier-paused); }
    .tier-section.tier-done { border-left-color: var(--tier-done); }
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
    .tier-toggle-button {
      display: inline-flex;
      align-items: center;
    }
    .tier-header-main:focus-visible,
    .tier-toggle-button:focus-visible,
    .tier-header-action:focus-visible,
    .source-provider-header:focus-visible,
    .source-group-header:focus-visible,
    .source-item:focus-visible,
    .item-action-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .item-card:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .tier-count,
    .tier-toggle,
    .item-time,
    .item-meta {
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
    .source-provider-header,
    .source-group-header {
      width: 100%;
      display: flex;
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
      gap: 4px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s;
      padding: 3px 5px;
      border-radius: 5px;
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
      border-radius: 3px;
      padding: 2px 6px;
      cursor: pointer;
      font-size: 12px;
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
      opacity: 0;
      cursor: grab;
      color: var(--vscode-descriptionForeground);
      margin-right: 4px;
      user-select: none;
      line-height: 1;
    }
    .item-card:hover .drag-handle,
    .item-card:focus-within .drag-handle {
      opacity: 0.6;
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
    .unseen-dot {
      color: var(--tier-incoming);
      line-height: 1.2;
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
    .item-meta {
      font-size: 11px;
    }
    .empty-state, .placeholder {
      padding: 16px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      font-style: italic;
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
  }
}

function getDiscoveredItemKey(providerId: string, externalId: string): string {
  return `${providerId}::${externalId}`;
}

function isFailedRun(runWatch: WatchedRun): boolean {
  return runWatch.status.overallState === 'completed'
    && runWatch.status.conclusion !== undefined
    && runWatch.status.conclusion !== 'success';
}

function normalizeText(value?: string): string {
  return value?.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ') ?? '';
}

function parseDiscoveredItemKey(value: string): { providerId: string; externalId: string } | undefined {
  const separatorIndex = value.indexOf('::');
  if (separatorIndex <= 0) {
    return undefined;
  }

  return {
    providerId: value.slice(0, separatorIndex),
    externalId: value.slice(separatorIndex + 2),
  };
}

function toDisplayLabel(value: string): string {
  return value.replace(/\b\w/g, char => char.toUpperCase());
}

function extractWorkContext(item: WorkItem): { branchName?: string; repoName?: string } {
  const entries = item.activityLog ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'work-started' || !entry.detail) {
      continue;
    }

    try {
      const parsed = JSON.parse(entry.detail) as { branchName?: unknown; repoPath?: unknown; worktreePath?: unknown };
      const branchName = typeof parsed.branchName === 'string' && parsed.branchName.length > 0 ? parsed.branchName : undefined;
      const repoName = extractRepoName(
        typeof parsed.repoPath === 'string' ? parsed.repoPath : typeof parsed.worktreePath === 'string' ? parsed.worktreePath : undefined,
      );
      if (branchName || repoName) {
        return { branchName, repoName };
      }
    } catch {
      continue;
    }
  }

  return {};
}

function extractRepoName(pathValue?: string): string | undefined {
  if (!pathValue) {
    return undefined;
  }

  const segments = pathValue.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
