import * as vscode from 'vscode';
import { WorkGraph } from '../services/workGraph';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { type SourceItemNode, type SourcesElement } from '../views/sourcesTreeProvider';
import { logger } from '../services/logger';
import type { ViewRevealer } from '../services/viewRevealer';
import {
  wrapCommand,
  handleCommandError,
  formatItemTitle,
  batchAcceptItems,
} from './commandUtils';

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

async function acceptSingleSourceItem(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item: SourceItemNode,
  revealer?: ViewRevealer,
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
    return;
  }
  void revealer?.revealInQueue(createdItem.id);
}

async function handleAcceptFromSources(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item?: SourcesElement,
  selectedItems?: SourcesElement[],
  revealer?: ViewRevealer,
): Promise<void> {
  const items = resolveSourceItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    await acceptSingleSourceItem(workGraph, stateStore, items[0], revealer);
    return;
  }

  await batchAcceptItems(workGraph, stateStore, items, 'source item');
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

export function registerSourcesCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  revealer?: ViewRevealer,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devdocket.acceptFromSources',
      wrapCommand('Failed to accept from sources', (item?: SourcesElement, selectedItems?: SourcesElement[]) => handleAcceptFromSources(workGraph, stateStore, item, selectedItems, revealer))),
    vscode.commands.registerCommand('devdocket.dismissFromSources',
      wrapCommand('Failed to dismiss from sources', (item?: SourcesElement, selectedItems?: SourcesElement[]) => handleDismissFromSources(stateStore, item, selectedItems))),
  );
}
