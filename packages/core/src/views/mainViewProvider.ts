import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { DiscoveredItem } from '../api/types';
import { type WorkItem, WorkItemState } from '../models/workItem';
import { ActionRegistry } from '../services/actionRegistry';
import { buildCanonicalHiddenSet } from '../services/canonicalDedup';
import { getInboxUnseenCount } from '../services/inboxBadge';
import { logger } from '../services/logger';
import { ProviderRegistry } from '../services/providerRegistry';
import { WatcherService, type WatchedPR, type WatchedRun } from '../services/watcherService';
import { WorkGraph } from '../services/workGraph';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { ReadStateStore } from '../storage/readStateStore';
import { isSafeUrl } from '../utils/url';
import { buildTierColorCss } from '../webview/shared/colors';
import { buildProviderBadge, buildProviderBadges, buildTypeBadge } from './badges';
import type {
  BadgeData,
  ItemCardData,
  SourceGroupData,
  SourceItemData,
  SourceProviderData,
  TierData,
  WebviewMessage,
} from './mainTypes';

export class MainViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'devdocket.main';
  private static readonly REFRESH_DEBOUNCE_MS = 50;

  private view?: vscode.WebviewView;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workGraph: WorkGraph,
    private readonly providerRegistry: ProviderRegistry,
    private readonly stateStore: DiscoveredStateStore,
    private readonly readStateStore: ReadStateStore,
    private readonly watcherService: WatcherService,
    private readonly actionRegistry: ActionRegistry,
  ) {}

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
  }

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
    if (this.disposed) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, MainViewProvider.REFRESH_DEBOUNCE_MS);
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
    this.updateBadge();
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
      .sort((a, b) => this.compareUrgency(a, b, discoveredItemMap)
        || (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
        || b.updatedAt - a.updatedAt)
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
    const key = getDiscoveredItemKey(providerId, discoveredItem.externalId);
    return {
      id: existingWorkItem?.id ?? key,
      title: discoveredItem.title,
      badges: this.buildBadges(providerId, discoveredItem, discoveredItem.url),
      repoAnnotation: discoveredItem.group ?? existingWorkItem?.group,
      tierType: 'incoming',
      isUnseen: !this.readStateStore.has(key),
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
    return {
      id: item.id,
      title: item.title,
      badges: this.buildBadges(item.providerId, discoveredItem, item.url),
      repoAnnotation: item.group ?? discoveredItem?.group,
      tierType,
      isUrgent: this.isUrgentWorkItem(item, discoveredItemMap),
      providerId: item.providerId,
      externalId: item.externalId,
    };
  }

  private buildBadges(providerId?: string, discoveredItem?: DiscoveredItem, itemUrl?: string): BadgeData[] {
    const badges: BadgeData[] = [];
    // Pass through the provider's human-readable label so third-party
    // providers (anything not GitHub/ADO) get a real name on the badge
    // instead of being mislabeled as "Manual".
    const providerLabel = providerId ? this.providerRegistry.getProviderLabel(providerId) : undefined;
    const providerBadge = buildProviderBadge(providerId, providerLabel);
    if (providerBadge) {
      badges.push(providerBadge);
    }

    const typeBadge = buildTypeBadge(discoveredItem);
    if (typeBadge) {
      badges.push(typeBadge);
    }

    badges.push(...buildProviderBadges(discoveredItem, 'sidebar'));

    const ciBadge = this.buildCIBadge(discoveredItem?.url ?? itemUrl);
    if (ciBadge) {
      badges.push(ciBadge);
    }

    return badges;
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

  private getRunCIBadge(watchedRun: WatchedRun): BadgeData | undefined {
    // hasWarning means we couldn't poll the run successfully — that's a
    // watcher health concern, not a CI failure. Don't surface it on the
    // sidebar item; the watch panel still shows the warning where it's
    // actionable.
    if (isFailedRun(watchedRun)) {
      return { label: 'CI failed', type: 'ci', variant: 'ci-fail' };
    }
    if (watchedRun.hasWarning) {
      return undefined;
    }
    if (watchedRun.status.overallState !== 'completed') {
      return { label: 'CI running', type: 'ci', variant: 'ci-running' };
    }
    return { label: 'CI passed', type: 'ci', variant: 'ci-pass' };
  }

  private getPRCIBadge(watchedPR: WatchedPR): BadgeData | undefined {
    const childRuns = this.watcherService.getChildRuns(this.watcherService.getPRWatchKey(watchedPR.identifier));
    // No CI runs detected — don't surface a CI status. The PR may simply
    // have no CI configured; runs may not have started yet; or the watcher
    // is having trouble polling (watchedPR.hasWarning) — none of those
    // mean "the CI failed".
    if (childRuns.length === 0) {
      return undefined;
    }
    if (childRuns.some(isFailedRun)) {
      return { label: 'CI failed', type: 'ci', variant: 'ci-fail' };
    }
    if (childRuns.some(runWatch => runWatch.status.overallState !== 'completed')) {
      return { label: 'CI running', type: 'ci', variant: 'ci-running' };
    }
    if (childRuns.every(runWatch => runWatch.status.conclusion === 'success')) {
      return { label: 'CI passed', type: 'ci', variant: 'ci-pass' };
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

        // No backing WorkItem yet — this is an incoming/discovered item key.
        // Open the editor in preview mode so the user can read details and
        // decide whether to accept or dismiss without committing yet.
        //
        // Prefer the explicit providerId/externalId from the message (the
        // webview always sends them for incoming cards). Fall back to parsing
        // the legacy `${providerId}::${externalId}` cache key only if those
        // aren't present, since '::' could appear inside a provider id and
        // would mis-split here.
        let providerId: string | undefined = message.providerId;
        let externalId: string | undefined = message.externalId;
        if (!providerId || !externalId) {
          const discoveredKey = parseDiscoveredItemKey(message.itemId);
          if (discoveredKey) {
            providerId = discoveredKey.providerId;
            externalId = discoveredKey.externalId;
          }
        }
        if (providerId && externalId) {
          await vscode.commands.executeCommand('devdocket.previewIncomingItem', {
            providerId,
            externalId,
          });
        }
        break;
      }
      case 'openSourceItem': {
        // Sources tab clicks: if the item has already been accepted into the
        // queue, open the regular WorkItem editor; otherwise open the
        // read-only preview panel so the user can decide whether to accept
        // or dismiss without committing.
        const existing = this.workGraph.findItemByProvenance(message.providerId, message.externalId);
        if (existing) {
          await vscode.commands.executeCommand('devdocket.editItem', { id: existing.id });
        } else {
          await vscode.commands.executeCommand('devdocket.previewIncomingItem', {
            providerId: message.providerId,
            externalId: message.externalId,
          });
        }
        break;
      }
      case 'acceptItem':
        await this.handleAcceptItem(message.providerId, message.externalId);
        break;
      case 'acceptToFocus':
        await this.handleAcceptToFocus(message.providerId, message.externalId);
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
      case 'crossTierDrop':
        await this.handleCrossTierDrop(message.itemId, message.targetTier);
        break;
      case 'createItem':
        await vscode.commands.executeCommand('devdocket.createItem');
        break;
      case 'openWalkthrough':
        await vscode.commands.executeCommand('devdocket.openWalkthrough');
        break;
      case 'clearHistory':
        await vscode.commands.executeCommand('devdocket.clearHistory');
        break;
      case 'runAction':
        await vscode.commands.executeCommand('devdocket.runAction', { id: message.itemId });
        break;
      case 'openUrl': {
        // Use the canonical href returned by isSafeUrl, not the raw
        // message.url. WHATWG URL and vscode.Uri.parse are different
        // parsers and could disagree on edge-case strings (embedded
        // NULs, unusual percent-encoding, IDN). All other openExternal
        // call sites in the codebase route through safeUrl.href; keep
        // that contract consistent here too.
        const safe = isSafeUrl(message.url);
        if (safe) {
          await vscode.env.openExternal(vscode.Uri.parse(safe.href));
        }
        break;
      }
      case 'switchTab':
        break;
      case 'markSeen':
        await this.handleMarkSeen(message.providerId, message.externalId);
        break;
    }
  }

  private async handleMarkSeen(providerId: string, externalId: string): Promise<void> {
    try {
      await this.readStateStore.add(getDiscoveredItemKey(providerId, externalId));
    } catch (err) {
      logger.error('DevDocket: markSeen failed', err);
    }
  }

  private async handleAcceptItem(providerId: string, externalId: string): Promise<void> {
    try {
      const existing = this.workGraph.findItemByProvenance(providerId, externalId);
      if (!existing) {
        const discoveredItem = this.providerRegistry.getDiscoveredItems(providerId).find(item => item.externalId === externalId);
        if (!discoveredItem) {
          logger.warn(`DevDocket: discovered item ${providerId}/${externalId} not found for accept`);
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
      logger.error('DevDocket: accept failed', err);
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

  private async handleAcceptToFocus(providerId: string, externalId: string): Promise<void> {
    // Delegate to the existing inbox-side command, which materializes a
    // WorkItem and transitions it straight to InProgress (skipping the
    // Ready to Start tier). Lets the user pull an inbox item directly into
    // active work without opening the editor first.
    try {
      await vscode.commands.executeCommand('devdocket.acceptToFocusFromInbox', { providerId, externalId });
    } catch (err) {
      logger.error('DevDocket: acceptToFocus failed', err);
      void vscode.window.showErrorMessage(`Failed to start item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleDismissItem(providerId: string, externalId: string): Promise<void> {
    try {
      await this.stateStore.setState(providerId, externalId, 'dismissed');
    } catch (err) {
      logger.error('DevDocket: dismiss failed', err);
      void vscode.window.showErrorMessage(`Failed to dismiss item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleTransitionState(itemId: string, targetState: string): Promise<void> {
    try {
      const item = this.workGraph.getItem(itemId);
      if (!item) {
        logger.warn(`DevDocket: item ${itemId} not found for transition`);
        return;
      }
      await this.workGraph.transitionState(itemId, targetState as WorkItemState);
    } catch (err) {
      logger.error('DevDocket: transition failed', err);
      void vscode.window.showErrorMessage(`Failed to transition item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Handle a card dragged from one reorderable tier into another (Ready ↔ In
   * Progress). The webview only fires this for those two tiers, but we still
   * validate the source state and target tier here as a defensive guard.
   */
  private async handleCrossTierDrop(itemId: string, targetTier: string): Promise<void> {
    const targetState = targetTier === 'in-progress'
      ? WorkItemState.InProgress
      : targetTier === 'ready-to-start'
        ? WorkItemState.New
        : undefined;
    if (!targetState) {
      logger.warn(`DevDocket: crossTierDrop ignored — unsupported target tier ${targetTier}`);
      return;
    }
    const item = this.workGraph.getItem(itemId);
    if (!item) {
      logger.warn(`DevDocket: crossTierDrop ignored — item ${itemId} not found`);
      return;
    }
    if (item.state === targetState) {
      // Same-state cross-tier drop is a no-op (handleReorder owns reorder).
      return;
    }
    await this.handleTransitionState(itemId, targetState);
  }

  private async handleReorder(itemIds: string[]): Promise<void> {
    try {
      if (itemIds.length < 2) {
        return;
      }

      // Determine the state to reorder within from the dragged items themselves.
      // All items in a reorder must belong to the same lifecycle state (cross-tier
      // drag is not supported), so derive the state from the first known item and
      // bail if any others disagree.
      const firstItem = this.workGraph.getItem(itemIds[0]);
      if (!firstItem) {
        logger.warn('DevDocket: reorder ignored because the first item could not be found');
        return;
      }
      const state = firstItem.state;
      if (state !== WorkItemState.New && state !== WorkItemState.InProgress) {
        logger.warn(`DevDocket: reorder ignored because state ${state} is not reorderable`);
        return;
      }
      for (const id of itemIds) {
        const item = this.workGraph.getItem(id);
        if (!item || item.state !== state) {
          logger.warn('DevDocket: reorder ignored because items span multiple states');
          return;
        }
      }

      const currentIds = this.workGraph
        .getItemsByState(state)
        .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
          || b.updatedAt - a.updatedAt)
        .map(item => item.id);

      if (currentIds.length !== itemIds.length) {
        logger.warn(`DevDocket: reorder ignored because ${state} items changed during drag`);
        return;
      }

      const currentIdSet = new Set(currentIds);
      if (new Set(itemIds).size !== itemIds.length || currentIds.some(itemId => !itemIds.includes(itemId)) || itemIds.some(itemId => !currentIdSet.has(itemId))) {
        logger.warn(`DevDocket: reorder ignored because it included unknown ${state} item ids`);
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
          logger.warn(`DevDocket: reorder ignored because item ${desiredId} was not in the ${state} tier`);
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
      logger.error('DevDocket: reorder failed', err);
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
  if (runWatch.status.overallState !== 'completed') return false;
  const conclusion = runWatch.status.conclusion;
  if (conclusion === undefined || conclusion === 'success') return false;
  // Cancelled / skipped / neutral runs aren't failures from a CI-health
  // standpoint — they're explicit non-results. Don't paint them red.
  if (conclusion === 'cancelled' || conclusion === 'skipped' || conclusion === 'neutral') return false;
  return true;
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

function getNonce(): string {
  // Cryptographically random nonce (matches editorPanelHtml). Math.random
  // is seeded per-process and predictable, which would make CSP a paper
  // shield if any future change introduced user-controlled HTML.
  return crypto.randomBytes(16).toString('hex');
}
