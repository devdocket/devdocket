import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { DiscoveredStateStore, type InboxState } from '../storage/discoveredStateStore';
import { type InboxItem, type InboxElement } from '../views/inboxTreeProvider';
import { logger } from '../services/logger';
import type { ViewRevealer } from '../services/viewRevealer';
import {
  wrapCommand,
  handleCommandError,
  formatItemTitle,
  batchAcceptItems,
} from './commandUtils';

function isInboxItem(i?: InboxElement): i is InboxItem {
  return !!i && i.kind === 'item' && !!i.providerId && !!i.externalId;
}

/**
 * Resolves the effective list of inbox items from VS Code's multi-select command args.
 * When canSelectMany is enabled, VS Code passes InboxElement (the union type) in
 * selectedItems, which may include provider/group nodes — we filter to leaf items only.
 * Falls back to the single context item when the filtered selection is empty or
 * does not include the right-clicked item.
 */
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

async function acceptSingleInboxItem(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item: InboxItem,
  revealer?: ViewRevealer,
): Promise<void> {
  logger.info(`Accepting inbox item: ${item.externalId} from ${item.providerId}`);
  const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
  if (existing) {
    // Re-open items in terminal states so resurfaced items return to Queue
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
      void revealer?.revealInQueue(existing.id);
      return;
    }
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
    try {
      await workGraph.deleteItem(createdItem.id);
    } catch (rollbackErr: unknown) {
      logger.error('Failed to roll back created item after setState failure', rollbackErr);
    }
    handleCommandError('Failed to update state after accepting item', err);
    return;
  }
  void revealer?.revealInQueue(createdItem.id);
}

async function acceptToFocusSingleInboxItem(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item: InboxItem,
  revealer?: ViewRevealer,
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
      const originalState = existing.state;
      try {
        await workGraph.transitionState(existing.id, WorkItemState.New);
      } catch (err: unknown) {
        handleCommandError('Failed to re-open item', err);
        return;
      }
      workItemId = existing.id;
      try {
        await stateStore.setState(item.providerId, item.externalId, 'accepted');
      } catch (err: unknown) {
        try { await workGraph.transitionState(existing.id, originalState); } catch (rollbackErr: unknown) {
          logger.error('Failed to roll back re-opened item after setState failure', rollbackErr);
        }
        handleCommandError('Failed to update state for re-opened item', err);
        return;
      }
    } else {
      workItemId = existing.id;
      try {
        await stateStore.setState(item.providerId, item.externalId, 'accepted');
      } catch (err: unknown) {
        handleCommandError('Failed to update state for existing accepted item', err);
        return;
      }
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
    return;
  }
  void revealer?.revealInFocus(workItemId);
}

async function batchAcceptToFocusItems(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  items: InboxItem[],
): Promise<void> {
  const stateUpdates: Array<{ providerId: string; externalId: string; state: InboxState }> = [];
  const createdIds: string[] = [];
  const allIds: string[] = [];
  const reopenedItems: Array<{ id: string; originalState: WorkItemState }> = [];
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
        const originalState = existing.state;
        try {
          await workGraph.transitionState(existing.id, WorkItemState.New);
          reopenedItems.push({ id: existing.id, originalState });
        } catch (err: unknown) {
          failed++;
          logger.error(`Failed to re-open "${item.title}"`, err);
          continue;
        }
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
      for (const { id, originalState } of reopenedItems) {
        try { await workGraph.transitionState(id, originalState); } catch (rollbackErr: unknown) {
          logger.error('Failed to roll back re-opened item after batch setStates failure', rollbackErr);
        }
      }
      handleCommandError('Failed to update states after accepting items', err);
      return;
    }
  }

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

async function handleAcceptFromInbox(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item?: InboxElement,
  selectedItems?: InboxElement[],
  revealer?: ViewRevealer,
): Promise<void> {
  const items = resolveInboxItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    await acceptSingleInboxItem(workGraph, stateStore, items[0], revealer);
    return;
  }

  await batchAcceptItems(workGraph, stateStore, items, 'inbox item');
}

async function handleAcceptToFocusFromInbox(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item?: InboxElement,
  selectedItems?: InboxElement[],
  revealer?: ViewRevealer,
): Promise<void> {
  const items = resolveInboxItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    await acceptToFocusSingleInboxItem(workGraph, stateStore, items[0], revealer);
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

export function registerInboxCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  revealer?: ViewRevealer,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devdocket.acceptFromInbox',
      wrapCommand('Failed to accept from inbox', (item?: InboxElement, selectedItems?: InboxElement[]) => handleAcceptFromInbox(workGraph, stateStore, item, selectedItems, revealer))),
    vscode.commands.registerCommand('devdocket.acceptToFocusFromInbox',
      wrapCommand('Failed to accept to focus from inbox', (item?: InboxElement, selectedItems?: InboxElement[]) => handleAcceptToFocusFromInbox(workGraph, stateStore, item, selectedItems, revealer))),
    vscode.commands.registerCommand('devdocket.dismissFromInbox',
      wrapCommand('Failed to dismiss from inbox', (item?: InboxElement, selectedItems?: InboxElement[]) => handleDismissFromInbox(stateStore, item, selectedItems))),
  );
}
