import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ActionRegistry } from '../services/actionRegistry';
import { ProviderRegistry } from '../services/providerRegistry';
import { DiscoveredStateStore, type InboxState } from '../storage/discoveredStateStore';
import type { ProviderLabelCache } from '../storage/providerLabelCache';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { type InboxItem, type InboxElement } from '../views/inboxTreeProvider';
import { type SourceItemNode, type SourcesElement } from '../views/sourcesTreeProvider';
import { logger } from '../services/logger';
import { toggleViewLayout, setViewLayout } from '../views/viewLayout';

/**
 * Resolves the effective list of inbox items from VS Code's multi-select command args.
 * When canSelectMany is enabled, VS Code passes InboxElement (the union type) in
 * selectedItems, which may include provider/group nodes — we filter to leaf items only.
 * Falls back to the single context item when the filtered selection is empty or
 * does not include the right-clicked item.
 */
function isInboxItem(i?: InboxElement): i is InboxItem {
  return !!i && i.kind === 'item' && !!i.providerId && !!i.externalId;
}

function resolveInboxItems(item?: InboxElement, selectedItems?: InboxElement[]): InboxItem[] {
  if (selectedItems && selectedItems.length > 0) {
    const filtered = selectedItems.filter(isInboxItem);
    if (filtered.length > 0 && (!isInboxItem(item) || filtered.some(
      f => f.providerId === item.providerId && f.externalId === item.externalId))) {
      return filtered;
    }
  }
  if (isInboxItem(item)) {
    return [item];
  }
  return [];
}

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

/** Returns the parsed URL if it uses an allowed web scheme (http or https), or null otherwise. */
export function isSafeUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed : null;
  } catch {
    return null;
  }
}

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
  let failed = 0;

  for (const item of items) {
    const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
    if (existing) {
      stateUpdates.push({ providerId: item.providerId, externalId: item.externalId, state: 'accepted' });
      continue;
    }
    try {
      const createdItem = await workGraph.createItem(
        { title: formatItemTitle(item) },
        { providerId: item.providerId, externalId: item.externalId, url: item.url, group: item.group?.trim() || undefined },
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
      handleCommandError('Failed to update states after accepting items', err);
      return;
    }
  }

  const total = stateUpdates.length;
  if (total > 0) {
    const msg = failed > 0
      ? `Accepted ${total} of ${total + failed} items to Queue`
      : `Accepted ${total} item${total === 1 ? '' : 's'} to Queue`;
    void vscode.window.showInformationMessage(msg);
  }
  if (failed > 0) {
    void vscode.window.showErrorMessage(
      `DevDocket: Failed to accept ${failed} item(s); see Output for details`,
    );
  }
}

async function handleCreateItem(workGraph: WorkGraph): Promise<void> {
  const title = await vscode.window.showInputBox({
    prompt: 'Work item title',
    placeHolder: 'e.g. Fix login redirect bug',
    validateInput: (value) => (value.trim() ? undefined : 'Title is required'),
  });
  if (!title) {
    return;
  }

  logger.info(`Creating new work item: ${title.trim()}`);
  await workGraph.createItem({ title: title.trim() });
  void vscode.window.showInformationMessage(`DevDocket: Created "${title.trim()}"`);
}

async function handleAcceptToFocus(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.InProgress,
    (n) => `Moved ${n} item${n === 1 ? '' : 's'} to Focus`);
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
    (n) => `Moved ${n} item${n === 1 ? '' : 's'} to Queue`);
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
  const config = vscode.workspace.getConfiguration('devdocket');
  const raw = config.get<number>('historyClearDays', 30);
  const maxAgeDays = Number.isFinite(raw) && raw >= 1 ? Math.round(raw) : 30;

  const confirm = await vscode.window.showWarningMessage(
    `Delete all history items older than ${maxAgeDays} day${maxAgeDays === 1 ? '' : 's'}?`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') { return; }

  const deleted = await workGraph.clearOldHistory(maxAgeDays);
  if (deleted > 0) {
    void vscode.window.showInformationMessage(`DevDocket: Cleared ${deleted} old history item${deleted === 1 ? '' : 's'}`);
  } else {
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

async function handleAcceptFromInbox(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item?: InboxElement,
  selectedItems?: InboxElement[],
): Promise<void> {
  const items = resolveInboxItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    await acceptSingleInboxItem(workGraph, stateStore, items[0]);
    return;
  }

  await batchAcceptItems(workGraph, stateStore, items, 'inbox item');
}

async function acceptSingleInboxItem(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item: InboxItem,
): Promise<void> {
  logger.info(`Accepting inbox item: ${item.externalId} from ${item.providerId}`);
  const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
  if (existing) {
    void vscode.window.showInformationMessage(
      `DevDocket: Item already accepted as "${existing.title}"`
    );
    try {
      await stateStore.setState(item.providerId, item.externalId, 'accepted');
    } catch (err: unknown) {
      handleCommandError('Failed to update state for existing accepted item', err);
    }
    return;
  }
  const group = item.group?.trim();
  let createdItem: Awaited<ReturnType<typeof workGraph.createItem>>;
  try {
    createdItem = await workGraph.createItem(
      { title: formatItemTitle(item) },
      {
        providerId: item.providerId,
        externalId: item.externalId,
        url: item.url,
        ...(group ? { group } : {}),
      },
    );
  } catch (err: unknown) {
    handleCommandError('Failed to accept inbox item', err);
    return;
  }
  try {
    await stateStore.setState(item.providerId, item.externalId, 'accepted');
  } catch (err: unknown) {
    // Roll back the created work item to prevent it appearing in Queue while still unseen in Inbox
    try {
      await workGraph.deleteItem(createdItem.id);
    } catch (rollbackErr: unknown) {
      logger.error('Failed to roll back created item after setState failure', rollbackErr);
    }
    handleCommandError('Failed to update state after accepting item', err);
  }
}

async function acceptToFocusSingleInboxItem(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item: InboxItem,
): Promise<void> {
  logger.info(`Accepting inbox item to Focus: ${item.externalId} from ${item.providerId}`);
  let workItemId: string;
  const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
  if (existing) {
    if (existing.state === WorkItemState.InProgress || existing.state === WorkItemState.Paused) {
      try {
        await stateStore.setState(item.providerId, item.externalId, 'accepted');
      } catch (err: unknown) {
        handleCommandError('Failed to update state for existing focus item', err);
        return;
      }
      void vscode.window.showInformationMessage('DevDocket: Item is already in Focus');
      return;
    }
    if (existing.state === WorkItemState.Done || existing.state === WorkItemState.Archived) {
      try {
        await stateStore.setState(item.providerId, item.externalId, 'accepted');
      } catch (err: unknown) {
        handleCommandError('Failed to update state for existing completed item', err);
        return;
      }
      void vscode.window.showWarningMessage(
        `DevDocket: Item is ${existing.state} and cannot be moved to Focus`,
      );
      return;
    }
    workItemId = existing.id;
    try {
      await stateStore.setState(item.providerId, item.externalId, 'accepted');
    } catch (err: unknown) {
      handleCommandError('Failed to update state for existing accepted item', err);
      return;
    }
  } else {
    const group = item.group?.trim();
    let createdItem: Awaited<ReturnType<typeof workGraph.createItem>>;
    try {
      createdItem = await workGraph.createItem(
        { title: formatItemTitle(item) },
        {
          providerId: item.providerId,
          externalId: item.externalId,
          url: item.url,
          ...(group ? { group } : {}),
        },
      );
    } catch (err: unknown) {
      handleCommandError('Failed to accept inbox item to Focus', err);
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
    workItemId = createdItem.id;
  }
  try {
    await workGraph.transitionState(workItemId, WorkItemState.InProgress);
  } catch (err: unknown) {
    handleCommandError('Failed to move item to Focus', err);
  }
}

async function batchAcceptToFocusItems(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  items: InboxItem[],
): Promise<void> {
  const stateUpdates: Array<{ providerId: string; externalId: string; state: InboxState }> = [];
  const createdIds: string[] = [];
  const allIds: string[] = [];
  let failed = 0;
  let skipped = 0;

  for (const item of items) {
    const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
    if (existing) {
      if (existing.state === WorkItemState.InProgress || existing.state === WorkItemState.Paused) {
        logger.info(`Skipping "${item.title}" — already in Focus`);
        stateUpdates.push({ providerId: item.providerId, externalId: item.externalId, state: 'accepted' });
        skipped++;
        continue;
      }
      if (existing.state === WorkItemState.Done || existing.state === WorkItemState.Archived) {
        logger.info(`Skipping "${item.title}" — item is ${existing.state} and cannot be moved to Focus`);
        stateUpdates.push({ providerId: item.providerId, externalId: item.externalId, state: 'accepted' });
        skipped++;
        continue;
      }
      stateUpdates.push({ providerId: item.providerId, externalId: item.externalId, state: 'accepted' });
      allIds.push(existing.id);
      continue;
    }
    const group = item.group?.trim();
    try {
      const createdItem = await workGraph.createItem(
        { title: formatItemTitle(item) },
        {
          providerId: item.providerId,
          externalId: item.externalId,
          url: item.url,
          ...(group ? { group } : {}),
        },
      );
      createdIds.push(createdItem.id);
      allIds.push(createdItem.id);
      stateUpdates.push({ providerId: item.providerId, externalId: item.externalId, state: 'accepted' });
    } catch (err: unknown) {
      failed++;
      logger.error(`Failed to accept inbox item to Focus "${item.title}"`, err);
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
      handleCommandError('Failed to update states after accepting items', err);
      return;
    }
  }

  // Transition all successfully accepted items to InProgress
  let transitionFailed = 0;
  for (const id of allIds) {
    try {
      await workGraph.transitionState(id, WorkItemState.InProgress);
    } catch (err: unknown) {
      transitionFailed++;
      logger.error(`Failed to transition item ${id} to Focus`, err);
    }
  }

  const succeeded = allIds.length - transitionFailed;
  if (succeeded > 0 || skipped > 0) {
    const parts: string[] = [];
    if (succeeded > 0) {
      parts.push(`Accepted ${succeeded} item${succeeded === 1 ? '' : 's'} to Focus`);
    }
    if (skipped > 0) {
      parts.push(`${skipped} item${skipped === 1 ? '' : 's'} already in Focus or cannot be moved`);
    }
    const msg = (failed > 0 || transitionFailed > 0)
      ? `${parts.join('; ')} (${failed + transitionFailed} failed)`
      : parts.join('; ');
    void vscode.window.showInformationMessage(msg);
  }
  if (failed > 0 || transitionFailed > 0) {
    void vscode.window.showErrorMessage(
      `DevDocket: Failed to process ${failed + transitionFailed} item(s); see Output for details`,
    );
  }
}

async function handleAcceptToFocusFromInbox(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item?: InboxElement,
  selectedItems?: InboxElement[],
): Promise<void> {
  const items = resolveInboxItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    await acceptToFocusSingleInboxItem(workGraph, stateStore, items[0]);
    return;
  }

  await batchAcceptToFocusItems(workGraph, stateStore, items);
}

async function handleDismissFromInbox(
  stateStore: DiscoveredStateStore,
  item?: InboxElement,
  selectedItems?: InboxElement[],
): Promise<void> {
  const items = resolveInboxItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    try {
      logger.info(`Dismissing inbox item: ${items[0].externalId}`);
      await stateStore.setState(items[0].providerId, items[0].externalId, 'dismissed');
    } catch (err: unknown) {
      handleCommandError('Failed to dismiss item', err);
    }
    return;
  }

  try {
    logger.info(`Batch dismissing ${items.length} inbox items`);
    await stateStore.setStates(
      items.map(i => ({ providerId: i.providerId, externalId: i.externalId, state: 'dismissed' as const }))
    );
    void vscode.window.showInformationMessage(`Dismissed ${items.length} items`);
  } catch (err: unknown) {
    handleCommandError('Failed to dismiss items', err);
  }
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
  item?: SourcesElement,
  selectedItems?: SourcesElement[],
): Promise<void> {
  const items = resolveSourceItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    await acceptSingleSourceItem(workGraph, stateStore, items[0]);
    return;
  }

  await batchAcceptItems(workGraph, stateStore, items, 'source item');
}

async function acceptSingleSourceItem(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item: SourceItemNode,
): Promise<void> {
  logger.info(`Accepting sources item: ${item.externalId}`);
  const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
  if (existing) {
    try {
      await stateStore.setState(item.providerId, item.externalId, 'accepted');
    } catch (err: unknown) {
      handleCommandError('Failed to update state for existing item', err);
    }
    void vscode.window.showInformationMessage(
      `DevDocket: Item already accepted as "${existing.title}"`
    );
    return;
  }
  const group = item.group?.trim();
  let createdItem: Awaited<ReturnType<typeof workGraph.createItem>>;
  try {
    createdItem = await workGraph.createItem(
      { title: formatItemTitle(item) },
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
  }
}

async function handleDismissFromSources(
  stateStore: DiscoveredStateStore,
  item?: SourcesElement,
  selectedItems?: SourcesElement[],
): Promise<void> {
  const items = resolveSourceItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    try {
      logger.info(`Dismissing source item: ${items[0].externalId}`);
      await stateStore.setState(items[0].providerId, items[0].externalId, 'dismissed');
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
  providerRegistry: ProviderRegistry,
  labelCache: ProviderLabelCache,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devdocket.refresh',
      wrapCommand('Failed to refresh', () => handleRefresh(providerRegistry))),
    vscode.commands.registerCommand('devdocket.createItem',
      wrapCommand('Failed to create item', () => handleCreateItem(workGraph))),
    vscode.commands.registerCommand('devdocket.acceptToFocus',
      wrapCommand('Failed to focus item', (item, selectedItems) => handleAcceptToFocus(workGraph, item, selectedItems))),
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
      wrapCommand('Failed to move item to queue', (item, selectedItems) => handleMoveToQueue(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.acceptFromInbox',
      wrapCommand('Failed to accept from inbox', (item: InboxElement, selectedItems?: InboxElement[]) => handleAcceptFromInbox(workGraph, stateStore, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.acceptToFocusFromInbox',
      wrapCommand('Failed to accept to focus from inbox', (item: InboxElement, selectedItems?: InboxElement[]) => handleAcceptToFocusFromInbox(workGraph, stateStore, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.dismissFromInbox',
      wrapCommand('Failed to dismiss from inbox', (item: InboxElement, selectedItems?: InboxElement[]) => handleDismissFromInbox(stateStore, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.acceptFromSources',
      wrapCommand('Failed to accept from sources', (item: SourcesElement, selectedItems?: SourcesElement[]) => handleAcceptFromSources(workGraph, stateStore, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.dismissFromSources',
      wrapCommand('Failed to dismiss from sources', (item: SourcesElement, selectedItems?: SourcesElement[]) => handleDismissFromSources(stateStore, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.switchInboxToTree',
      wrapCommand('Failed to switch inbox layout', () => setViewLayout('inbox', 'tree'))),
    vscode.commands.registerCommand('devdocket.switchInboxToFlat',
      wrapCommand('Failed to switch inbox layout', () => setViewLayout('inbox', 'flat'))),
    vscode.commands.registerCommand('devdocket.switchQueueToTree',
      wrapCommand('Failed to switch queue layout', () => setViewLayout('queue', 'tree'))),
    vscode.commands.registerCommand('devdocket.switchQueueToFlat',
      wrapCommand('Failed to switch queue layout', () => setViewLayout('queue', 'flat'))),
    vscode.commands.registerCommand('devdocket.switchFocusToTree',
      wrapCommand('Failed to switch focus layout', () => setViewLayout('focus', 'tree'))),
    vscode.commands.registerCommand('devdocket.switchFocusToFlat',
      wrapCommand('Failed to switch focus layout', () => setViewLayout('focus', 'flat'))),
    vscode.commands.registerCommand('devdocket.switchHistoryToTree',
      wrapCommand('Failed to switch history layout', () => setViewLayout('history', 'tree'))),
    vscode.commands.registerCommand('devdocket.switchHistoryToFlat',
      wrapCommand('Failed to switch history layout', () => setViewLayout('history', 'flat'))),
    vscode.commands.registerCommand('devdocket.switchSourcesToTree',
      wrapCommand('Failed to switch sources layout', () => setViewLayout('sources', 'tree'))),
    vscode.commands.registerCommand('devdocket.switchSourcesToFlat',
      wrapCommand('Failed to switch sources layout', () => setViewLayout('sources', 'flat'))),
    // Toggle commands — cycle between flat and tree layouts via a single command
    vscode.commands.registerCommand('devdocket.toggleInboxLayout',
      wrapCommand('Failed to switch inbox layout', () => toggleViewLayout('inbox'))),
    vscode.commands.registerCommand('devdocket.toggleQueueLayout',
      wrapCommand('Failed to switch queue layout', () => toggleViewLayout('queue'))),
    vscode.commands.registerCommand('devdocket.toggleFocusLayout',
      wrapCommand('Failed to switch focus layout', () => toggleViewLayout('focus'))),
    vscode.commands.registerCommand('devdocket.toggleHistoryLayout',
      wrapCommand('Failed to switch history layout', () => toggleViewLayout('history'))),
    vscode.commands.registerCommand('devdocket.toggleSourcesLayout',
      wrapCommand('Failed to switch sources layout', () => toggleViewLayout('sources'))),
  );
}
