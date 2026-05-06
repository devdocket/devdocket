import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { ACTIVITY_TYPES, type ActivityType } from '../models/activityLog';
import { WorkGraph } from '../services/workGraph';
import { ActionRegistry } from '../services/actionRegistry';
import { ProviderRegistry } from '../services/providerRegistry';
import { DiscoveredStateStore, type InboxState } from '../storage/discoveredStateStore';
import type { ProviderLabelCache } from '../storage/providerLabelCache';
import type { ReadStateStore } from '../storage/readStateStore';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { IncomingPreviewPanel } from '../views/incomingPreviewPanel';
import { type InboxItem, type SourceItemNode, type SourcesElement } from './commandItemTypes';
import { logger } from '../services/logger';
import type { ResolvedItem } from '../api/types';
import { WatcherService } from '../services/watcherService';
import { WatcherRegistry } from '../services/watcherRegistry';
import { PRWatcherRegistry } from '../services/prWatcherRegistry';
import { registerWatchCommands } from './watchCommands';
import { registerInboxCommands } from './inboxCommands';
import { showProviderHealthQuickPick } from '../views/providerHealthStatusBar';
import type { WatchPanelProvider } from '../views/watchPanelProvider';
import { isSafeUrl } from '../utils/url';

/**
 * Resolves item IDs from VS Code multi-select args for WorkItem-based views.
 * Falls back to the single context item when the filtered selection is empty or
 * does not include the right-clicked item.
 */
function resolveItemIds(item?: { id?: string }, selectedItems?: { id?: string }[]): string[] {
  if (selectedItems && selectedItems.length > 0) {
    const filtered = selectedItems.map(i => i?.id).filter((id): id is string => !!id);
    if (filtered.length > 0 && (!item?.id || filtered.includes(item.id))) {
      return filtered;
    }
  }
  if (item?.id) {
    return [item.id];
  }
  return [];
}

function isSourceItem(i?: SourcesElement): i is SourceItemNode {
  return !!i && i.kind === 'item' && !!i.providerId && !!i.externalId;
}

function resolveSourceItems(item?: SourcesElement, selectedItems?: SourcesElement[]): SourceItemNode[] {
  if (selectedItems && selectedItems.length > 0) {
    const filtered = selectedItems.filter(isSourceItem);
    if (filtered.length > 0 && (!isSourceItem(item) || filtered.some(
      f => f.providerId === item.providerId && f.externalId === item.externalId))) {
      return filtered;
    }
  }
  if (isSourceItem(item)) {
    return [item];
  }
  return [];
}

/** Builds a work-item title, optionally prefixed with the provider group. */
function formatItemTitle(item: { group?: string; title: string }): string {
  const trimmedGroup = item.group?.trim();
  return trimmedGroup ? `${trimmedGroup} ${item.title}` : item.title;
}

// isSafeUrl is imported from ../utils/url.

/** Log the error and show a user-facing message. */
function handleCommandError(context: string, err: unknown): void {
  logger.error(context, err);
  const detail = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(`DevDocket: ${context} — ${detail}`);
}

/** Wrap a command handler so unhandled errors are logged and shown to the user. */
function wrapCommand<T extends unknown[]>(label: string, fn: (...args: T) => Promise<void> | void): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (err: unknown) {
      handleCommandError(label, err);
    }
  };
}

// ---------------------------------------------------------------------------
// Canonical ID dedup helpers
// ---------------------------------------------------------------------------

/** Item with optional canonicalId — accepted by findCanonicalPeers. */
interface CanonicalItem {
  providerId: string;
  externalId: string;
  canonicalId?: string;
}

/**
 * Finds all unseen inbox items from other providers that share the same
 * canonicalId as the given item. Used to propagate accept/dismiss actions.
 */
function findCanonicalPeers(
  item: CanonicalItem,
  providerRegistry: ProviderRegistry,
  stateStore: DiscoveredStateStore,
): Array<{ providerId: string; externalId: string }> {
  if (!item.canonicalId) { return []; }
  const peers: Array<{ providerId: string; externalId: string }> = [];
  for (const [providerId, items] of providerRegistry.getAllDiscoveredItems()) {
    for (const discovered of items) {
      if (discovered.canonicalId !== item.canonicalId) { continue; }
      if (providerId === item.providerId && discovered.externalId === item.externalId) { continue; }
      const state = stateStore.getState(providerId, discovered.externalId);
      if (state !== undefined && state !== 'unseen') { continue; }
      peers.push({ providerId, externalId: discovered.externalId });
    }
  }
  return peers;
}

/** Propagates an inbox state change to all canonical peers of the given item. */
async function propagateStateToCanonicalPeers(
  item: CanonicalItem,
  providerRegistry: ProviderRegistry,
  stateStore: DiscoveredStateStore,
  state: 'accepted' | 'dismissed',
): Promise<void> {
  const peers = findCanonicalPeers(item, providerRegistry, stateStore);
  if (peers.length === 0) { return; }
  try {
    await stateStore.setStates(peers.map(p => ({ ...p, state })));
  } catch (err: unknown) {
    logger.error('Failed to propagate state to canonical peers', err);
  }
}

/**
 * Expands a list of inbox items by adding canonical peers that haven't already
 * been explicitly selected. Ensures accept/dismiss propagates to all duplicates.
 */
function expandWithCanonicalPeers(
  items: InboxItem[],
  providerRegistry: ProviderRegistry,
  stateStore: DiscoveredStateStore,
): InboxItem[] {
  const keys = new Set(items.map(i => `${i.providerId}::${i.externalId}`));
  const extra: InboxItem[] = [];
  for (const item of items) {
    const peers = findCanonicalPeers(item, providerRegistry, stateStore);
    for (const peer of peers) {
      const peerKey = `${peer.providerId}::${peer.externalId}`;
      if (!keys.has(peerKey)) {
        keys.add(peerKey);
        extra.push({
          kind: 'item',
          providerId: peer.providerId,
          externalId: peer.externalId,
          title: item.title,
          url: item.url,
          group: item.group,
        });
      }
    }
  }
  return [...items, ...extra];
}

// ---------------------------------------------------------------------------
// Individual command handlers
// ---------------------------------------------------------------------------

/**
 * Transitions multiple items to a target state. Single items use the direct
 * path (errors bubble to wrapCommand). Batches continue on individual failures
 * and show a summary message.
 */
async function batchTransition(
  workGraph: WorkGraph,
  ids: string[],
  targetState: WorkItemState,
  successMessage: (count: number) => string,
): Promise<void> {
  if (ids.length === 1) {
    await workGraph.transitionState(ids[0], targetState);
    return;
  }
  const failedIds: string[] = [];
  for (const id of ids) {
    try {
      await workGraph.transitionState(id, targetState);
    } catch (err: unknown) {
      failedIds.push(id);
      logger.error(`Failed to transition item ${id}`, err);
    }
  }
  const succeeded = ids.length - failedIds.length;
  if (succeeded > 0) {
    void vscode.window.showInformationMessage(successMessage(succeeded));
  }
  if (failedIds.length > 0) {
    void vscode.window.showErrorMessage(
      `DevDocket: Failed to transition ${failedIds.length} item(s); see Output for details`,
    );
  }
}

/** Shared logic for batch-accepting discovered items (Inbox or Sources). */
interface AcceptableItem {
  providerId: string;
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  group?: string;
}

async function batchAcceptItems(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  items: AcceptableItem[],
  logLabel: string,
): Promise<void> {
  const stateUpdates: Array<{ providerId: string; externalId: string; state: InboxState }> = [];
  const createdIds: string[] = [];
  // Track re-opened items so we can roll back on setStates failure
  const reopenedItems: Array<{ id: string; originalState: WorkItemState }> = [];
  let failed = 0;

  for (const item of items) {
    const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
    if (existing) {
      // Re-open items in terminal states so resurfaced items return to Ready to Start
      if (existing.state === WorkItemState.Done || existing.state === WorkItemState.Archived) {
        const originalState = existing.state;
        try {
          await workGraph.transitionState(existing.id, WorkItemState.New);
          reopenedItems.push({ id: existing.id, originalState });
        } catch (err: unknown) {
          failed++;
          logger.error(`Failed to re-open ${logLabel} "${item.title}"`, err);
          continue;
        }
      }
      stateUpdates.push({ providerId: item.providerId, externalId: item.externalId, state: 'accepted' });
      continue;
    }
    try {
      const createdItem = await workGraph.createItem(
        { title: formatItemTitle(item), description: item.description },
        { providerId: item.providerId, externalId: item.externalId, itemType: item.itemType, url: item.url, group: item.group?.trim() || undefined },
      );
      createdIds.push(createdItem.id);
      stateUpdates.push({ providerId: item.providerId, externalId: item.externalId, state: 'accepted' });
    } catch (err: unknown) {
      failed++;
      logger.error(`Failed to accept ${logLabel} "${item.title}"`, err);
    }
  }

  if (stateUpdates.length > 0) {
    try {
      await stateStore.setStates(stateUpdates);
    } catch (err: unknown) {
      for (const id of createdIds) {
        try { await workGraph.deleteItem(id); } catch (rollbackErr: unknown) {
          logger.error('Failed to roll back created item after batch setStates failure', rollbackErr);
        }
      }
      for (const { id, originalState } of reopenedItems) {
        try { await workGraph.transitionState(id, originalState); } catch (rollbackErr: unknown) {
          logger.error('Failed to roll back re-opened item after batch setStates failure', rollbackErr);
        }
      }
      handleCommandError('Failed to update states after accepting items', err);
      return;
    }
  }

  const total = stateUpdates.length;
  if (total > 0) {
    const msg = failed > 0
      ? `Accepted ${total} of ${total + failed} items to Ready to Start`
      : `Accepted ${total} item${total === 1 ? '' : 's'} to Ready to Start`;
    void vscode.window.showInformationMessage(msg);
  }
  if (failed > 0) {
    void vscode.window.showErrorMessage(
      `DevDocket: Failed to accept ${failed} item(s); see Output for details`,
    );
  }
}

async function handleCreateItem(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  providerRegistry: ProviderRegistry,
  labelCache: ProviderLabelCache,
): Promise<void> {
  const title = await vscode.window.showInputBox({
    prompt: 'Work item title',
    placeHolder: 'e.g. Fix login redirect bug',
    validateInput: (value) => (value.trim() ? undefined : 'Title is required'),
  });
  if (!title) {
    return;
  }

  logger.info(`Creating new work item: ${title.trim()}`);
  const createdItem = await workGraph.createItem({ title: title.trim() });
  const providerLabel = createdItem.providerId ? labelCache.get(createdItem.providerId) : undefined;
  void WorkItemEditorPanel.open(context, workGraph, providerRegistry, createdItem, providerLabel);
  void vscode.window.showInformationMessage(`DevDocket: Created "${title.trim()}"`);
}

async function handleCreateItemFromUrl(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  providerRegistry: ProviderRegistry,
  labelCache: ProviderLabelCache,
): Promise<void> {
  const url = await vscode.window.showInputBox({
    prompt: 'Enter a URL to create a work item from',
  });
  if (!url?.trim()) { return; }

  if (!isSafeUrl(url.trim())) {
    void vscode.window.showErrorMessage('DevDocket: Please enter a valid HTTP or HTTPS URL');
    return;
  }

  let details: ResolvedItem | undefined;
  try {
    details = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'DevDocket: Fetching item details…', cancellable: true },
      (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return providerRegistry.resolveUrl(url.trim(), controller.signal);
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return;
    }
    throw error;
  }

  if (!details) {
    void vscode.window.showErrorMessage('DevDocket: No provider recognised this URL');
    return;
  }

  // Prevent duplicate items for the same provider-backed source item
  const existing = workGraph.findItemByProvenance(details.providerId, details.externalId);
  if (existing) {
    const providerLabel = existing.providerId ? labelCache.get(existing.providerId) : undefined;
    WorkItemEditorPanel.open(context, workGraph, providerRegistry, existing, providerLabel);
    void vscode.window.showInformationMessage('DevDocket: Item already exists for this source item');
    return;
  }

  const group = details.group?.trim() || undefined;
  const createdItem = await workGraph.createItem(
    { title: details.title, notes: details.notes },
    { providerId: details.providerId, externalId: details.externalId, url: details.url, ...(group ? { group } : {}) },
  );

  const providerLabel = createdItem.providerId ? labelCache.get(createdItem.providerId) : undefined;
  WorkItemEditorPanel.open(context, workGraph, providerRegistry, createdItem, providerLabel);
  void vscode.window.showInformationMessage(`DevDocket: Created "${details.title}"`);
}

async function handleAcceptToFocus(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.InProgress,
    (n) => `Moved ${n} item${n === 1 ? '' : 's'} to In Progress`);
}

async function handleArchiveItem(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.Archived,
    (n) => `Archived ${n} item${n === 1 ? '' : 's'}`);
}

async function handleCompleteItem(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.Done,
    (n) => `Completed ${n} item${n === 1 ? '' : 's'}`);
}

async function handlePauseItem(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.Paused,
    (n) => `Paused ${n} item${n === 1 ? '' : 's'}`);
}

async function handleResumeItem(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.InProgress,
    (n) => `Resumed ${n} item${n === 1 ? '' : 's'}`);
}

async function handleMoveToQueue(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.New,
    (n) => `Moved ${n} item${n === 1 ? '' : 's'} to Ready to Start`);
}

function handleEditItem(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  providerRegistry: ProviderRegistry,
  labelCache: ProviderLabelCache,
  item?: { id?: string },
): void {
  if (!item?.id) { return; }
  const workItem = workGraph.getItem(item.id);
  if (workItem) {
    const providerLabel = workItem.providerId ? labelCache.get(workItem.providerId) : undefined;
    WorkItemEditorPanel.open(context, workGraph, providerRegistry, workItem, providerLabel);
  }
}

async function handleOpenInBrowser(workGraph: WorkGraph, item?: { id?: string; url?: string }): Promise<void> {
  if (!item || (!item.id && !item.url)) {
    void vscode.window.showWarningMessage('DevDocket: Select an item to open in the browser.');
    return;
  }
  const workItem = item.id ? workGraph.getItem(item.id) : undefined;
  const url = workItem?.url ?? item.url;
  if (!url) {
    void vscode.window.showWarningMessage('This item has no URL to open.');
    return;
  }
  const safeUrl = isSafeUrl(url);
  if (!safeUrl) {
    const display = url.length > 100 ? url.slice(0, 100) + '…' : url;
    const sanitized = display.replace(/[\n\r]/g, ' ');
    void vscode.window.showWarningMessage(`Cannot open non-web URL: ${sanitized}`);
    return;
  }
  const opened = await vscode.env.openExternal(vscode.Uri.parse(safeUrl.href));
  if (!opened) {
    void vscode.window.showWarningMessage('Failed to open URL in the browser.');
  }
}

async function handleCopyUrl(workGraph: WorkGraph, item?: { id?: string; url?: string }): Promise<void> {
  if (!item || (!item.id && !item.url)) {
    void vscode.window.showWarningMessage('DevDocket: Select an item to copy its URL.');
    return;
  }
  const workItem = item.id ? workGraph.getItem(item.id) : undefined;
  const url = workItem?.url ?? item.url;
  if (!url) {
    void vscode.window.showWarningMessage('This item has no URL to copy.');
    return;
  }

  await vscode.env.clipboard.writeText(url);
  vscode.window.setStatusBarMessage('DevDocket: URL copied to clipboard', 3000);
}

async function handleRunAction(
  workGraph: WorkGraph,
  actionRegistry: ActionRegistry,
  item?: { id?: string },
): Promise<void> {
  if (!item?.id) { return; }
  const workItem = workGraph.getItem(item.id);
  if (!workItem) {
    return;
  }
  const actions = actionRegistry.getActionsFor(workItem);
  if (actions.length === 0) {
    logger.warn(`No actions available for item ${workItem.id}`);
    void vscode.window.showInformationMessage('No actions available for this item.');
    return;
  }
  const picks = actions.map((a) => ({ label: a.label, actionId: a.id }));
  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Select an action',
  });
  if (selected) {
    const action = actionRegistry.getAction(selected.actionId);
    if (action) {
      try {
        logger.info(`Running action: ${selected.actionId} on item ${workItem.id}`);
        await action.run(workItem);
      } catch (err: unknown) {
        logger.error('Action failed: ' + selected.label, err);
        const detail = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`DevDocket: Action "${selected.label}" failed — ${detail}`);
      }
    }
  }
}

async function handleMoveUp(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) {
    void vscode.window.showInformationMessage('DevDocket: Select an item in the Queue to move.');
    return;
  }
  await workGraph.moveItem(item.id, 'up');
}

async function handleMoveDown(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) {
    void vscode.window.showInformationMessage('DevDocket: Select an item in the Queue to move.');
    return;
  }
  await workGraph.moveItem(item.id, 'down');
}

async function handleDeleteItem(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }

  // Confirm before destructive delete
  const itemWord = ids.length === 1 ? 'item' : `${ids.length} items`;
  const confirm = await vscode.window.showWarningMessage(
    `Delete ${itemWord}? This cannot be undone.`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') { return; }

  if (ids.length === 1) {
    await workGraph.deleteItem(ids[0]);
    return;
  }
  const failedIds: string[] = [];
  for (const id of ids) {
    try {
      await workGraph.deleteItem(id);
    } catch (err: unknown) {
      failedIds.push(id);
      logger.error(`Failed to delete item ${id}`, err);
    }
  }
  const succeeded = ids.length - failedIds.length;
  if (succeeded > 0) {
    void vscode.window.showInformationMessage(`Deleted ${succeeded} item${succeeded === 1 ? '' : 's'}`);
  }
  if (failedIds.length > 0) {
    void vscode.window.showErrorMessage(
      `DevDocket: Failed to delete ${failedIds.length} item(s); see Output for details`,
    );
  }
}

async function handleClearHistory(workGraph: WorkGraph): Promise<void> {
  const config = vscode.workspace.getConfiguration('devDocket');
  const raw = config.get<number>('historyClearDays', 30);
  const maxAgeDays = Number.isFinite(raw) && raw >= 1 ? Math.ceil(raw) : 30;

  const confirm = await vscode.window.showWarningMessage(
    `Delete all history items older than ${maxAgeDays} day${maxAgeDays === 1 ? '' : 's'}? This cannot be undone.`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') { return; }

  const result = await workGraph.clearOldHistory(maxAgeDays);
  if (result.failed > 0) {
    void vscode.window.showErrorMessage(
      `DevDocket: Failed to delete ${result.failed} item(s); see Output for details`,
    );
  }
  if (result.deleted > 0) {
    void vscode.window.showInformationMessage(`DevDocket: Cleared ${result.deleted} old history item${result.deleted === 1 ? '' : 's'}`);
  } else if (result.failed === 0) {
    void vscode.window.showInformationMessage('DevDocket: No history items older than the threshold');
  }
}

async function handleFocusMoveUp(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) {
    void vscode.window.showInformationMessage('DevDocket: Select an item in Focus to move.');
    return;
  }
  await workGraph.moveItem(item.id, 'up');
}

async function handleFocusMoveDown(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) {
    void vscode.window.showInformationMessage('DevDocket: Select an item in Focus to move.');
    return;
  }
  await workGraph.moveItem(item.id, 'down');
}

async function handleRefresh(providerRegistry: ProviderRegistry): Promise<void> {
  logger.info('Manual refresh triggered');
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'DevDocket: Refreshing…',
    },
    () => providerRegistry.refreshAll(),
  );
}

async function handleAcceptFromSources(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
  item?: SourcesElement,
  selectedItems?: SourcesElement[],
): Promise<void> {
  const items = resolveSourceItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    await acceptSingleSourceItem(workGraph, stateStore, providerRegistry, items[0]);
    return;
  }

  await batchAcceptItems(workGraph, stateStore, items, 'source item');
  // Propagate accepted state to canonical peers of all batch items
  for (const i of items) {
    await propagateStateToCanonicalPeers(i, providerRegistry, stateStore, 'accepted');
  }
}

async function acceptSingleSourceItem(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
  item: SourceItemNode,
): Promise<void> {
  logger.info(`Accepting sources item: ${item.externalId}`);
  const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
  if (existing) {
    // Re-open items in terminal states so resurfaced items return to Ready to Start
    if (existing.state === WorkItemState.Done || existing.state === WorkItemState.Archived) {
      const originalState = existing.state;
      try {
        await workGraph.transitionState(existing.id, WorkItemState.New);
      } catch (err: unknown) {
        handleCommandError('Failed to re-open item', err);
        return;
      }
      try {
        await stateStore.setState(item.providerId, item.externalId, 'accepted');
      } catch (err: unknown) {
        try { await workGraph.transitionState(existing.id, originalState); } catch (rollbackErr: unknown) {
          logger.error('Failed to roll back re-opened item after setState failure', rollbackErr);
        }
        handleCommandError('Failed to update state for re-opened item', err);
        return;
      }
      await propagateStateToCanonicalPeers(item, providerRegistry, stateStore, 'accepted');
      return;
    }
    try {
      await stateStore.setState(item.providerId, item.externalId, 'accepted');
    } catch (err: unknown) {
      handleCommandError('Failed to update state for existing item', err);
    }
    await propagateStateToCanonicalPeers(item, providerRegistry, stateStore, 'accepted');
    void vscode.window.showInformationMessage(
      `DevDocket: Item already accepted as "${existing.title}"`
    );
    return;
  }
  const group = item.group?.trim();
  let createdItem: Awaited<ReturnType<typeof workGraph.createItem>>;
  try {
    createdItem = await workGraph.createItem(
      { title: formatItemTitle(item), description: item.description },
      {
        providerId: item.providerId,
        externalId: item.externalId,
        url: item.url,
        ...(group ? { group } : {}),
      },
    );
  } catch (err: unknown) {
    handleCommandError('Failed to accept sources item', err);
    return;
  }
  try {
    await stateStore.setState(item.providerId, item.externalId, 'accepted');
  } catch (err: unknown) {
    try {
      await workGraph.deleteItem(createdItem.id);
    } catch (rollbackErr: unknown) {
      logger.error('Failed to roll back created item after setState failure', rollbackErr);
    }
    handleCommandError('Failed to update state after accepting item', err);
    return;
  }
  await propagateStateToCanonicalPeers(item, providerRegistry, stateStore, 'accepted');
}

async function handleDismissFromSources(
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
  item?: SourcesElement,
  selectedItems?: SourcesElement[],
): Promise<void> {
  const items = resolveSourceItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    try {
      logger.info(`Dismissing source item: ${items[0].externalId}`);
      await stateStore.setState(items[0].providerId, items[0].externalId, 'dismissed');
      await propagateStateToCanonicalPeers(items[0], providerRegistry, stateStore, 'dismissed');
    } catch (err: unknown) {
      handleCommandError('Failed to dismiss item', err);
    }
    return;
  }

  try {
    logger.info(`Batch dismissing ${items.length} source items`);
    await stateStore.setStates(
      items.map(i => ({ providerId: i.providerId, externalId: i.externalId, state: 'dismissed' as const }))
    );
    for (const i of items) {
      await propagateStateToCanonicalPeers(i, providerRegistry, stateStore, 'dismissed');
    }
    void vscode.window.showInformationMessage(`Dismissed ${items.length} items`);
  } catch (err: unknown) {
    handleCommandError('Failed to dismiss items', err);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  actionRegistry: ActionRegistry,
  stateStore: DiscoveredStateStore,
  readStateStore: ReadStateStore,
  providerRegistry: ProviderRegistry,
  labelCache: ProviderLabelCache,
  watcherRegistry: WatcherRegistry,
  prWatcherRegistry: PRWatcherRegistry,
  watcherService: WatcherService,
  watchPanelProvider: WatchPanelProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devdocket.refresh',
      wrapCommand('Failed to refresh', () => handleRefresh(providerRegistry))),
    vscode.commands.registerCommand('devdocket.openWalkthrough',
      wrapCommand('Failed to open walkthrough', () =>
        vscode.commands.executeCommand(
          'workbench.action.openWalkthrough',
          'mthalman.devdocket#devdocket.gettingStarted',
          false,
        ),
      )),
    vscode.commands.registerCommand('devdocket.createItem',
      wrapCommand('Failed to create item', () => handleCreateItem(context, workGraph, providerRegistry, labelCache))),
    vscode.commands.registerCommand('devdocket.createItemFromUrl',
      wrapCommand('Failed to create item from URL', () => handleCreateItemFromUrl(context, workGraph, providerRegistry, labelCache))),
    vscode.commands.registerCommand('devdocket.previewIncomingItem',
      wrapCommand('Failed to preview incoming item', (arg: unknown) => {
        if (!arg || typeof arg !== 'object') {
          throw new Error('previewIncomingItem requires { providerId, externalId }');
        }
        const { providerId, externalId } = arg as { providerId?: unknown; externalId?: unknown };
        if (typeof providerId !== 'string' || typeof externalId !== 'string') {
          throw new Error('previewIncomingItem requires string providerId and externalId');
        }
        IncomingPreviewPanel.open(context, providerRegistry, stateStore, readStateStore, workGraph, providerId, externalId);
      })),
    vscode.commands.registerCommand('devdocket.acceptToFocus',
      wrapCommand('Failed to move item to In Progress', (item, selectedItems) => handleAcceptToFocus(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.archiveItem',
      wrapCommand('Failed to archive item', (item, selectedItems) => handleArchiveItem(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.completeItem',
      wrapCommand('Failed to complete item', (item, selectedItems) => handleCompleteItem(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.pauseItem',
      wrapCommand('Failed to pause item', (item, selectedItems) => handlePauseItem(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.resumeItem',
      wrapCommand('Failed to resume item', (item, selectedItems) => handleResumeItem(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.deleteItem',
      wrapCommand('Failed to delete item', (item, selectedItems) => handleDeleteItem(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.clearHistory',
      wrapCommand('Failed to clear history', () => handleClearHistory(workGraph))),
    vscode.commands.registerCommand('devdocket.editItem',
      wrapCommand('Failed to open editor', (item) => handleEditItem(context, workGraph, providerRegistry, labelCache, item))),
    vscode.commands.registerCommand('devdocket.openInBrowser',
      wrapCommand('Failed to open in browser', (item) => handleOpenInBrowser(workGraph, item))),
    vscode.commands.registerCommand('devdocket.copyUrl',
      wrapCommand('Failed to copy URL', (item) => handleCopyUrl(workGraph, item))),
    vscode.commands.registerCommand('devdocket.runAction',
      wrapCommand('Failed to run action', (item) => handleRunAction(workGraph, actionRegistry, item))),
    vscode.commands.registerCommand('devdocket.moveUp',
      wrapCommand('Failed to move item up', (item) => handleMoveUp(workGraph, item))),
    vscode.commands.registerCommand('devdocket.moveDown',
      wrapCommand('Failed to move item down', (item) => handleMoveDown(workGraph, item))),
    vscode.commands.registerCommand('devdocket.focusMoveUp',
      wrapCommand('Failed to move focus item up', (item) => handleFocusMoveUp(workGraph, item))),
    vscode.commands.registerCommand('devdocket.focusMoveDown',
      wrapCommand('Failed to move focus item down', (item) => handleFocusMoveDown(workGraph, item))),
    vscode.commands.registerCommand('devdocket.moveToQueue',
      wrapCommand('Failed to move item to Ready to Start', (item, selectedItems) => handleMoveToQueue(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.acceptFromSources',
      wrapCommand('Failed to accept from sources', (item: SourcesElement, selectedItems?: SourcesElement[]) => handleAcceptFromSources(workGraph, stateStore, providerRegistry, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.dismissFromSources',
      wrapCommand('Failed to dismiss from sources', (item: SourcesElement, selectedItems?: SourcesElement[]) => handleDismissFromSources(stateStore, providerRegistry, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.showProviderHealthQuickPick',
      wrapCommand('Failed to show provider health quick pick', () => showProviderHealthQuickPick(providerRegistry))),
    vscode.commands.registerCommand('devdocket.addActivity',
      (itemId: string, type: string, detail?: unknown) => {
        if (!ACTIVITY_TYPES.includes(type as ActivityType)) {
          throw new Error(`Invalid activity type: ${type}. Expected one of: ${ACTIVITY_TYPES.join(', ')}`);
        }
        if (detail !== undefined && typeof detail !== 'string') {
          throw new Error('Activity detail must be a string or undefined');
        }
        return workGraph.addActivity(itemId, type as ActivityType, detail);
      }),
  );

  registerInboxCommands(context, workGraph, stateStore, providerRegistry);
  registerWatchCommands(context, watcherRegistry, prWatcherRegistry, watcherService, watchPanelProvider);
}
