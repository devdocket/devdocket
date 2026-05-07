import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import { buildCanonicalHiddenSet } from '../services/canonicalDedup';
import { DiscoveredStateStore, type InboxState } from '../storage/discoveredStateStore';
import {
  type InboxItem,
  type InboxElement,
  type InboxProviderNode,
  type InboxGroupNode,
} from './commandItemTypes';
import { logger } from '../services/logger';
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

function isBulkInboxNode(node?: InboxElement): node is InboxProviderNode | InboxGroupNode {
  return !!node && (node.kind === 'provider' || node.kind === 'group');
}

interface CanonicalItem {
  providerId: string;
  externalId: string;
  canonicalId?: string;
}

function findCanonicalPeers(
  item: CanonicalItem,
  providerRegistry: ProviderRegistry,
  stateStore: DiscoveredStateStore,
): Array<{ providerId: string; externalId: string; itemType?: 'issue' | 'pr' }> {
  if (!item.canonicalId) { return []; }
  const peers: Array<{ providerId: string; externalId: string; itemType?: 'issue' | 'pr' }> = [];
  for (const [providerId, items] of providerRegistry.getAllDiscoveredItems()) {
    for (const discovered of items) {
      if (discovered.canonicalId !== item.canonicalId) { continue; }
      if (providerId === item.providerId && discovered.externalId === item.externalId) { continue; }
      const state = stateStore.getState(providerId, discovered.externalId);
      if (state !== undefined && state !== 'unseen') { continue; }
      peers.push({ providerId, externalId: discovered.externalId, itemType: discovered.itemType });
    }
  }
  return peers;
}

async function propagateStateToCanonicalPeers(
  item: CanonicalItem,
  providerRegistry: ProviderRegistry,
  stateStore: DiscoveredStateStore,
  state: 'accepted' | 'dismissed',
): Promise<void> {
  const peers = findCanonicalPeers(item, providerRegistry, stateStore);
  if (peers.length === 0) { return; }
  try {
    await stateStore.setStates(peers.map(peer => ({ ...peer, state })));
  } catch (err: unknown) {
    logger.error('Failed to propagate state to canonical peers', err);
  }
}

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
      if (keys.has(peerKey)) { continue; }
      keys.add(peerKey);
      extra.push({
        kind: 'item',
        providerId: peer.providerId,
        externalId: peer.externalId,
        title: item.title,
        description: item.description,
        itemType: peer.itemType ?? item.itemType,
        url: item.url,
        group: item.group,
        canonicalId: item.canonicalId,
      });
    }
  }
  return [...items, ...extra];
}

async function propagateStateToCanonicalPeersBatch(
  items: InboxItem[],
  providerRegistry: ProviderRegistry,
  stateStore: DiscoveredStateStore,
  state: 'accepted' | 'dismissed',
): Promise<void> {
  const expanded = expandWithCanonicalPeers(items, providerRegistry, stateStore);
  const itemKeys = new Set(items.map(item => `${item.providerId}::${item.externalId}`));
  const peers = expanded.filter(item => !itemKeys.has(`${item.providerId}::${item.externalId}`));
  if (peers.length === 0) { return; }
  try {
    await stateStore.setStates(peers.map(peer => ({ providerId: peer.providerId, externalId: peer.externalId, state })));
  } catch (err: unknown) {
    logger.error('Failed to propagate state to canonical peers', err);
  }
}

function resolveBulkInboxItems(
  node: InboxProviderNode | InboxGroupNode,
  providerRegistry: ProviderRegistry,
  stateStore: DiscoveredStateStore,
): InboxItem[] {
  const hidden = buildCanonicalHiddenSet(
    providerRegistry.getAllDiscoveredItems(),
    (providerId, externalId) => stateStore.getState(providerId, externalId),
  );

  return providerRegistry.getDiscoveredItems(node.providerId)
    .filter(item => {
      if (node.kind === 'group' && item.group?.trim() !== node.groupName) { return false; }
      const state = stateStore.getState(node.providerId, item.externalId);
      if (state !== undefined && state !== 'unseen') { return false; }
      return !hidden.has(`${node.providerId}::${item.externalId}`);
    })
    .map(item => ({
      kind: 'item' as const,
      providerId: node.providerId,
      externalId: item.externalId,
      title: item.title,
      description: item.description,
      itemType: item.itemType,
      url: item.url,
      group: item.group,
      reason: item.reason,
      canonicalId: item.canonicalId,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

function getBulkNodePath(node: InboxProviderNode | InboxGroupNode, providerRegistry: ProviderRegistry): string {
  if (node.kind === 'provider') {
    return node.label;
  }

  return `${providerRegistry.getProviderLabel(node.providerId)} > ${node.groupName}`;
}

function formatBulkInboxMessage(
  verb: 'Dismiss' | 'Accept',
  count: number,
  node: InboxProviderNode | InboxGroupNode,
  providerRegistry: ProviderRegistry,
  destination?: 'Ready to Start' | 'In Progress',
): string {
  const suffix = destination ? ` to ${destination}` : '';
  return `${verb} ${count} item${count === 1 ? '' : 's'} from "${getBulkNodePath(node, providerRegistry)}"${suffix}?`;
}

async function acceptSingleInboxItem(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
  item: InboxItem,
): Promise<void> {
  logger.info(`Accepting inbox item: ${item.externalId} from ${item.providerId}`);
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
    void vscode.window.showInformationMessage(
      `DevDocket: Item already accepted as "${existing.title}"`
    );
    try {
      await stateStore.setState(item.providerId, item.externalId, 'accepted');
    } catch (err: unknown) {
      handleCommandError('Failed to update state for existing accepted item', err);
      return;
    }
    await propagateStateToCanonicalPeers(item, providerRegistry, stateStore, 'accepted');
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
        itemType: item.itemType,
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
  await propagateStateToCanonicalPeers(item, providerRegistry, stateStore, 'accepted');
}

async function acceptToFocusSingleInboxItem(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
  item: InboxItem,
): Promise<void> {
  logger.info(`Accepting inbox item to In Progress: ${item.externalId} from ${item.providerId}`);
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
      void vscode.window.showInformationMessage('DevDocket: Item is already In Progress');
      await propagateStateToCanonicalPeers(item, providerRegistry, stateStore, 'accepted');
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
        { title: formatItemTitle(item), description: item.description },
        {
          providerId: item.providerId,
          externalId: item.externalId,
          itemType: item.itemType,
          url: item.url,
          ...(group ? { group } : {}),
        },
      );
    } catch (err: unknown) {
      handleCommandError('Failed to accept inbox item to In Progress', err);
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
    handleCommandError('Failed to move item to In Progress', err);
    return;
  }
  await propagateStateToCanonicalPeers(item, providerRegistry, stateStore, 'accepted');
}

async function batchAcceptToFocusItems(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  items: InboxItem[],
): Promise<InboxItem[]> {
  const stateUpdates: Array<{ providerId: string; externalId: string; state: InboxState }> = [];
  const acceptedItems: InboxItem[] = [];
  const createdIds: string[] = [];
  const allIds: string[] = [];
  const reopenedItems: Array<{ id: string; originalState: WorkItemState }> = [];
  let failed = 0;
  let skipped = 0;

  for (const item of items) {
    const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
    if (existing) {
      if (existing.state === WorkItemState.InProgress || existing.state === WorkItemState.Paused) {
        logger.info(`Skipping "${item.title}" — already In Progress`);
        stateUpdates.push({ providerId: item.providerId, externalId: item.externalId, state: 'accepted' });
        acceptedItems.push(item);
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
      acceptedItems.push(item);
      allIds.push(existing.id);
      continue;
    }
    const group = item.group?.trim();
    try {
      const createdItem = await workGraph.createItem(
        { title: formatItemTitle(item), description: item.description },
        {
          providerId: item.providerId,
          externalId: item.externalId,
          itemType: item.itemType,
          url: item.url,
          ...(group ? { group } : {}),
        },
      );
      createdIds.push(createdItem.id);
      allIds.push(createdItem.id);
      stateUpdates.push({ providerId: item.providerId, externalId: item.externalId, state: 'accepted' });
      acceptedItems.push(item);
    } catch (err: unknown) {
      failed++;
      logger.error(`Failed to accept inbox item to In Progress "${item.title}"`, err);
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
      return [];
    }
  }

  let transitionFailed = 0;
  for (const id of allIds) {
    try {
      await workGraph.transitionState(id, WorkItemState.InProgress);
    } catch (err: unknown) {
      transitionFailed++;
      logger.error(`Failed to transition item ${id} to In Progress`, err);
    }
  }

  const succeeded = allIds.length - transitionFailed;
  if (succeeded > 0 || skipped > 0) {
    const parts: string[] = [];
    if (succeeded > 0) {
      parts.push(`Accepted ${succeeded} item${succeeded === 1 ? '' : 's'} to In Progress`);
    }
    if (skipped > 0) {
      parts.push(`${skipped} item${skipped === 1 ? '' : 's'} already In Progress or cannot be moved`);
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

  return acceptedItems;
}

async function handleAcceptFromInbox(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
  item?: InboxElement,
  selectedItems?: InboxElement[],
): Promise<void> {
  const items = resolveInboxItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    await acceptSingleInboxItem(workGraph, stateStore, providerRegistry, items[0]);
    return;
  }

  const acceptedItems = await batchAcceptItems(workGraph, stateStore, items, 'inbox item');
  await propagateStateToCanonicalPeersBatch(acceptedItems, providerRegistry, stateStore, 'accepted');
}

async function handleAcceptToFocusFromInbox(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
  item?: InboxElement,
  selectedItems?: InboxElement[],
): Promise<void> {
  const items = resolveInboxItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    await acceptToFocusSingleInboxItem(workGraph, stateStore, providerRegistry, items[0]);
    return;
  }

  const acceptedItems = await batchAcceptToFocusItems(workGraph, stateStore, items);
  await propagateStateToCanonicalPeersBatch(acceptedItems, providerRegistry, stateStore, 'accepted');
}

async function handleDismissFromInbox(
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
  item?: InboxElement,
  selectedItems?: InboxElement[],
): Promise<void> {
  const items = resolveInboxItems(item, selectedItems);
  if (items.length === 0) { return; }

  const expanded = expandWithCanonicalPeers(items, providerRegistry, stateStore);

  if (expanded.length === 1) {
    try {
      logger.info(`Dismissing inbox item: ${expanded[0].externalId}`);
      await stateStore.setState(expanded[0].providerId, expanded[0].externalId, 'dismissed');
    } catch (err: unknown) {
      handleCommandError('Failed to dismiss item', err);
    }
    return;
  }

  try {
    logger.info(`Batch dismissing ${expanded.length} inbox items`);
    await stateStore.setStates(
      expanded.map(i => ({ providerId: i.providerId, externalId: i.externalId, state: 'dismissed' as const }))
    );
    void vscode.window.showInformationMessage(`Dismissed ${expanded.length} item${expanded.length === 1 ? '' : 's'}`);
  } catch (err: unknown) {
    handleCommandError('Failed to dismiss items', err);
  }
}

async function handleAcceptAllFromInbox(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
  node?: InboxElement,
): Promise<void> {
  if (!isBulkInboxNode(node)) { return; }

  const items = resolveBulkInboxItems(node, providerRegistry, stateStore);
  if (items.length === 0) { return; }

  const confirm = await vscode.window.showInformationMessage(
    formatBulkInboxMessage('Accept', items.length, node, providerRegistry, 'Ready to Start'),
    { modal: true },
    'Accept All to Ready to Start',
  );
  if (confirm !== 'Accept All to Ready to Start') { return; }

  const acceptedItems = await batchAcceptItems(workGraph, stateStore, items, 'inbox item');
  await propagateStateToCanonicalPeersBatch(acceptedItems, providerRegistry, stateStore, 'accepted');
}

async function handleAcceptAllToFocusFromInbox(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
  node?: InboxElement,
): Promise<void> {
  if (!isBulkInboxNode(node)) { return; }

  const items = resolveBulkInboxItems(node, providerRegistry, stateStore);
  if (items.length === 0) { return; }

  const confirm = await vscode.window.showInformationMessage(
    formatBulkInboxMessage('Accept', items.length, node, providerRegistry, 'In Progress'),
    { modal: true },
    'Accept All to In Progress',
  );
  if (confirm !== 'Accept All to In Progress') { return; }

  const acceptedItems = await batchAcceptToFocusItems(workGraph, stateStore, items);
  await propagateStateToCanonicalPeersBatch(acceptedItems, providerRegistry, stateStore, 'accepted');
}

async function handleDismissAllFromInbox(
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
  node?: InboxElement,
): Promise<void> {
  if (!isBulkInboxNode(node)) { return; }

  const items = resolveBulkInboxItems(node, providerRegistry, stateStore);
  if (items.length === 0) { return; }

  const expanded = expandWithCanonicalPeers(items, providerRegistry, stateStore);
  const confirm = await vscode.window.showWarningMessage(
    formatBulkInboxMessage('Dismiss', expanded.length, node, providerRegistry),
    { modal: true },
    'Dismiss All',
  );
  if (confirm !== 'Dismiss All') { return; }

  try {
    logger.info(`Batch dismissing ${expanded.length} inbox items from node ${getBulkNodePath(node, providerRegistry)}`);
    await stateStore.setStates(
      expanded.map(i => ({ providerId: i.providerId, externalId: i.externalId, state: 'dismissed' as const }))
    );
    void vscode.window.showInformationMessage(`Dismissed ${expanded.length} item${expanded.length === 1 ? '' : 's'}`);
  } catch (err: unknown) {
    handleCommandError('Failed to dismiss items', err);
  }
}

export function registerInboxCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devdocket.acceptFromInbox',
      wrapCommand('Failed to accept from inbox', (item?: InboxElement, selectedItems?: InboxElement[]) => handleAcceptFromInbox(workGraph, stateStore, providerRegistry, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.acceptToFocusFromInbox',
      wrapCommand('Failed to accept to In Progress from inbox', (item?: InboxElement, selectedItems?: InboxElement[]) => handleAcceptToFocusFromInbox(workGraph, stateStore, providerRegistry, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.dismissFromInbox',
      wrapCommand('Failed to dismiss from inbox', (item?: InboxElement, selectedItems?: InboxElement[]) => handleDismissFromInbox(stateStore, providerRegistry, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.acceptAllFromInbox',
      wrapCommand('Failed to accept all from inbox', (item?: InboxElement) => handleAcceptAllFromInbox(workGraph, stateStore, providerRegistry, item))),
    vscode.commands.registerCommand('devdocket.acceptAllToFocusFromInbox',
      wrapCommand('Failed to accept all to In Progress from inbox', (item?: InboxElement) => handleAcceptAllToFocusFromInbox(workGraph, stateStore, providerRegistry, item))),
    vscode.commands.registerCommand('devdocket.dismissAllFromInbox',
      wrapCommand('Failed to dismiss all from inbox', (item?: InboxElement) => handleDismissAllFromInbox(stateStore, providerRegistry, item))),
  );
}
