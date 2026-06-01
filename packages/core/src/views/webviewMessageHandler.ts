import * as vscode from 'vscode';
import type { ProviderItem } from '../api/types';
import { WorkItemState } from '../models/workItem';
import { logger } from '../services/logger';
import type { ProviderRegistry } from '../services/providerRegistry';
import type { WorkGraph } from '../services/workGraph';
import type { InboxStateStore } from '../storage/inboxStateStore';
import type { ReadStateStore } from '../storage/readStateStore';
import { isSafeUrl } from '../utils/url';
import { buildFocusWatchTarget } from './focusWatchTarget';
import type { ItemCardData, TierData, WebviewMessage } from './mainTypes';
import { getProviderItemKey, parseProviderItemKey } from './providerItemKey';
import { isReorderableState, sortReorderBaselineItems } from './sidebarOrdering';
import { buildAcceptPayload } from './tierSnapshotBuilder';

export interface MainWebviewMessageHandlerOptions {
  workGraph: WorkGraph;
  providerRegistry: ProviderRegistry;
  stateStore: InboxStateStore;
  readStateStore: ReadStateStore;
  getCurrentTiers(): TierData[];
  onWebviewReady(): void;
  toggleSearch(): void;
}

export class MainWebviewMessageHandler {
  constructor(private readonly options: MainWebviewMessageHandlerOptions) {}

  async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'webviewReady':
        this.options.onWebviewReady();
        break;
      case 'openItem': {
        const workItem = this.options.workGraph.getItem(message.itemId);
        if (workItem) {
          await vscode.commands.executeCommand('devdocket.editItem', { id: message.itemId });
          break;
        }

        // No backing WorkItem yet — this is an incoming/discovered item key.
        // Prefer explicit identity from the webview; parse the legacy cache key only as fallback.
        let providerId: string | undefined = message.providerId;
        let externalId: string | undefined = message.externalId;
        if (!providerId || !externalId) {
          const discoveredKey = parseProviderItemKey(message.itemId);
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
        const existing = this.options.workGraph.findItemByProvenance(message.providerId, message.externalId);
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
      case 'showProviderHealth':
        await vscode.commands.executeCommand('devdocket.showProviderHealthQuickPick');
        break;
      case 'acceptItem':
        await this.handleAcceptItem(message.providerId, message.externalId);
        break;
      case 'acceptToFocus':
        await this.handleAcceptToFocus(message.providerId, message.externalId);
        break;
      case 'acceptAll':
        await this.handleAcceptAll(message.items);
        break;
      case 'dismissItem':
        await this.handleDismissItem(message.providerId, message.externalId);
        break;
      case 'transitionState':
        await this.handleTransitionState(message.itemId, message.targetState);
        break;
      case 'bulkTransition':
        await this.handleBulkTransition(message.itemIds, message.targetState);
        break;
      case 'bulkInboxAction':
        await this.handleBulkInboxAction(message.action, message.items);
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
      case 'browseProviderExtensions':
        await vscode.commands.executeCommand('devdocket.browseProviderExtensions');
        break;
      case 'clearHistory':
        await vscode.commands.executeCommand('devdocket.clearHistory');
        break;
      case 'runAction':
        await vscode.commands.executeCommand('devdocket.runAction', { id: message.itemId });
        break;
      case 'openUrl': {
        const safe = isSafeUrl(message.url);
        if (safe) {
          await vscode.env.openExternal(vscode.Uri.parse(safe.href));
        }
        break;
      }
      case 'switchTab':
        break;
      case 'requestToggleSearch':
        this.options.toggleSearch();
        break;
      case 'markSeen':
        await this.handleMarkSeen(message.providerId, message.externalId);
        break;
      case 'openWatches': {
        const target = buildFocusWatchTarget(message);
        if (target) {
          await vscode.commands.executeCommand('devdocket.showWatchesQuickPick', target);
        } else {
          await vscode.commands.executeCommand('devdocket.showWatchesQuickPick');
        }
        break;
      }
      case 'openWorktree':
        if (typeof message.itemId === 'string' && message.itemId.length > 0) {
          await vscode.commands.executeCommand('devdocket.openWorktreeForItem', { id: message.itemId });
        }
        break;
    }
  }

  private async handleMarkSeen(providerId: string, externalId: string): Promise<void> {
    if (typeof providerId !== 'string' || typeof externalId !== 'string' || !providerId || !externalId) {
      logger.warn('DevDocket: markSeen ignored due to invalid providerId/externalId payload');
      return;
    }
    try {
      await this.options.readStateStore.add(getProviderItemKey(providerId, externalId));
    } catch (err) {
      logger.error('DevDocket: markSeen failed', err);
    }
  }

  private async handleAcceptItem(providerId: string, externalId: string): Promise<void> {
    try {
      const providerItem = this.options.providerRegistry.getProviderItems(providerId).find(item => item.externalId === externalId);
      if (!providerItem) {
        logger.warn(`DevDocket: discovered item ${providerId}/${externalId} not found for accept`);
        return;
      }

      await vscode.commands.executeCommand('devdocket.acceptFromInbox', buildAcceptPayload(providerId, providerItem));
    } catch (err) {
      logger.error('DevDocket: accept failed', err);
      void vscode.window.showErrorMessage(`Failed to accept item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleAcceptAll(requestedItems?: ReadonlyArray<{ providerId: string; externalId: string }>): Promise<void> {
    const incomingTier = this.options.getCurrentTiers().find(tier => tier.id === 'incoming');
    if (!incomingTier) {
      return;
    }

    const requestedByProvider = requestedItems?.reduce((index, item) => {
      const providerItems = index.get(item.providerId) ?? new Set<string>();
      providerItems.add(item.externalId);
      index.set(item.providerId, providerItems);
      return index;
    }, new Map<string, Set<string>>());
    const itemsToAccept = incomingTier.items.filter((item): item is ItemCardData & { providerId: string; externalId: string } => (
      Boolean(item.providerId)
      && Boolean(item.externalId)
      && (!requestedByProvider || requestedByProvider.get(item.providerId)?.has(item.externalId) === true)
    ));
    if (itemsToAccept.length === 0) {
      return;
    }

    const confirm = await vscode.window.showInformationMessage(
      `Accept all ${itemsToAccept.length} item${itemsToAccept.length === 1 ? '' : 's'} into Ready to Start? You can still triage them one by one.`,
      { modal: true },
      'Accept All',
    );
    if (confirm !== 'Accept All') {
      return;
    }

    const payloads = itemsToAccept
      .map(item => {
        const providerItem = this.options.providerRegistry.getProviderItems(item.providerId).find(candidate => candidate.externalId === item.externalId);
        return providerItem ? buildAcceptPayload(item.providerId, providerItem) : undefined;
      })
      .filter((item): item is ReturnType<typeof buildAcceptPayload> => item !== undefined);
    if (payloads.length === 0) {
      return;
    }

    try {
      const acceptedItems = await vscode.commands.executeCommand<Array<{ providerId: string; externalId: string }>>('devdocket.acceptAllFromInbox', payloads);
      await this.options.readStateStore.addMany((acceptedItems ?? []).map(item => getProviderItemKey(item.providerId, item.externalId)));
    } catch (err) {
      logger.error('DevDocket: accept all failed', err);
      void vscode.window.showErrorMessage(`Failed to accept items: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleAcceptToFocus(providerId: string, externalId: string): Promise<void> {
    try {
      const providerItem = this.options.providerRegistry.getProviderItems(providerId).find(item => item.externalId === externalId);
      if (!providerItem) {
        logger.warn(`DevDocket: discovered item ${providerId}/${externalId} not found for acceptToFocus`);
        return;
      }

      await vscode.commands.executeCommand('devdocket.acceptToFocusFromInbox', buildAcceptPayload(providerId, providerItem));
    } catch (err) {
      logger.error('DevDocket: acceptToFocus failed', err);
      void vscode.window.showErrorMessage(`Failed to start item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleDismissItem(providerId: string, externalId: string): Promise<void> {
    try {
      await this.options.stateStore.setState(providerId, externalId, 'dismissed');
    } catch (err) {
      logger.error('DevDocket: dismiss failed', err);
      void vscode.window.showErrorMessage(`Failed to dismiss item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleBulkTransition(itemIds: readonly string[], targetState: string): Promise<void> {
    if (!isWorkItemState(targetState)) {
      logger.error(`DevDocket: bulk transition rejected — unsupported targetState ${targetState}`);
      void vscode.window.showErrorMessage(`Unsupported target state: ${targetState}.`);
      return;
    }
    const targetWorkState: WorkItemState = targetState;
    let failures = 0;
    for (const itemId of itemIds) {
      const item = this.options.workGraph.getItem(itemId);
      if (!item) {
        logger.warn(`DevDocket: bulk transition skipped — item ${itemId} not found`);
        failures += 1;
        continue;
      }
      try {
        if (item.state === WorkItemState.Paused && targetWorkState === WorkItemState.InProgress) {
          await this.options.workGraph.resumeItem(itemId);
        } else {
          await this.options.workGraph.transitionState(itemId, targetWorkState);
        }
      } catch (err) {
        failures += 1;
        logger.error(`DevDocket: bulk transition of ${itemId} to ${targetState} failed`, err);
      }
    }
    if (failures > 0) {
      void vscode.window.showErrorMessage(
        `Failed to transition ${failures} item${failures === 1 ? '' : 's'} to ${formatStateLabel(targetState)}.`,
      );
    }
  }

  private async handleBulkInboxAction(
    action: 'accept' | 'dismiss',
    items: ReadonlyArray<{ providerId: string; externalId: string }>,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }

    if (action === 'accept') {
      const providerIndexes = new Map<string, Map<string, ProviderItem>>();
      const getProviderIndex = (providerId: string): Map<string, ProviderItem> => {
        let index = providerIndexes.get(providerId);
        if (!index) {
          index = new Map();
          for (const candidate of this.options.providerRegistry.getProviderItems(providerId)) {
            index.set(candidate.externalId, candidate);
          }
          providerIndexes.set(providerId, index);
        }
        return index;
      };
      const payloads = items
        .map(({ providerId, externalId }) => {
          const providerItem = getProviderIndex(providerId).get(externalId);
          return providerItem ? buildAcceptPayload(providerId, providerItem) : undefined;
        })
        .filter((item): item is ReturnType<typeof buildAcceptPayload> => item !== undefined);
      if (payloads.length === 0) {
        return;
      }
      try {
        const acceptedItems = await vscode.commands.executeCommand<Array<{ providerId: string; externalId: string }>>('devdocket.acceptAllFromInbox', payloads);
        await this.options.readStateStore.addMany((acceptedItems ?? []).map(item => getProviderItemKey(item.providerId, item.externalId)));
      } catch (err) {
        logger.error('DevDocket: bulk accept failed', err);
        void vscode.window.showErrorMessage(`Failed to accept items: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    try {
      await this.options.stateStore.setStates(
        items.map(({ providerId, externalId }) => ({ providerId, externalId, state: 'dismissed' as const })),
      );
    } catch (err) {
      logger.error('DevDocket: bulk dismiss failed', err);
      void vscode.window.showErrorMessage(`Failed to dismiss items: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleTransitionState(itemId: string, targetState: string): Promise<void> {
    try {
      const item = this.options.workGraph.getItem(itemId);
      if (!item) {
        logger.warn(`DevDocket: item ${itemId} not found for transition`);
        return;
      }
      if (item.state === WorkItemState.Paused && targetState === WorkItemState.InProgress) {
        await this.options.workGraph.resumeItem(itemId);
      } else {
        await this.options.workGraph.transitionState(itemId, targetState as WorkItemState);
      }
    } catch (err) {
      logger.error('DevDocket: transition failed', err);
      void vscode.window.showErrorMessage(`Failed to transition item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
    const item = this.options.workGraph.getItem(itemId);
    if (!item) {
      logger.warn(`DevDocket: crossTierDrop ignored — item ${itemId} not found`);
      return;
    }
    if (item.state === targetState) {
      return;
    }
    await this.handleTransitionState(itemId, targetState);
  }

  private async handleReorder(itemIds: string[]): Promise<void> {
    try {
      if (itemIds.length < 2) {
        return;
      }

      const firstItem = this.options.workGraph.getItem(itemIds[0]);
      if (!firstItem) {
        logger.warn('DevDocket: reorder ignored because the first item could not be found');
        return;
      }
      const state = firstItem.state;
      if (!isReorderableState(state)) {
        logger.warn(`DevDocket: reorder ignored because state ${state} is not reorderable`);
        return;
      }
      for (const id of itemIds) {
        const item = this.options.workGraph.getItem(id);
        if (!item || item.state !== state) {
          logger.warn('DevDocket: reorder ignored because items span multiple states');
          return;
        }
      }

      const currentIds = sortReorderBaselineItems(this.options.workGraph.getItemsByState(state))
        .map(item => item.id);

      if (currentIds.length !== itemIds.length) {
        logger.warn(`DevDocket: reorder ignored because ${state} items changed during drag`);
        return;
      }

      const currentIdSet = new Set(currentIds);
      const itemIdSet = new Set(itemIds);
      if (itemIdSet.size !== itemIds.length || currentIds.some(itemId => !itemIdSet.has(itemId)) || itemIds.some(itemId => !currentIdSet.has(itemId))) {
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
          await this.options.workGraph.moveToEnd(desiredId);
        } else {
          await this.options.workGraph.reorderItem(desiredId, workingIds[index]);
        }

        workingIds.splice(draggedIndex, 1);
        workingIds.splice(index, 0, desiredId);
      }
    } catch (err) {
      logger.error('DevDocket: reorder failed', err);
      void vscode.window.showErrorMessage(`Failed to reorder items: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const WORK_ITEM_STATES = new Set<string>(Object.values(WorkItemState));

function isWorkItemState(value: string): value is WorkItemState {
  return WORK_ITEM_STATES.has(value);
}

function formatStateLabel(state: string): string {
  return state === WorkItemState.InProgress
    ? 'In Progress'
    : state.replace(/([a-z])([A-Z])/g, '$1 $2');
}
