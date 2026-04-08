import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ActionRegistry } from '../services/actionRegistry';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { InboxItem } from '../views/inboxTreeProvider';
import { SourceItemNode } from '../views/sourcesTreeProvider';
import { logger } from '../services/logger';

/** Builds a work-item title, optionally prefixed with the provider group. */
function formatItemTitle(item: { group?: string; title: string }): string {
  const trimmedGroup = item.group?.trim();
  return trimmedGroup ? `${trimmedGroup} ${item.title}` : item.title;
}

// ---------------------------------------------------------------------------
// Individual command handlers
// ---------------------------------------------------------------------------

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
  vscode.window.showInformationMessage(`WorkCenter: Created "${title.trim()}"`);
}

async function handleAcceptToFocus(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  await workGraph.transitionState(item.id, WorkItemState.InProgress);
}

async function handleArchiveItem(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  await workGraph.transitionState(item.id, WorkItemState.Archived);
}

async function handleCompleteItem(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  await workGraph.transitionState(item.id, WorkItemState.Done);
}

async function handlePauseItem(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  await workGraph.transitionState(item.id, WorkItemState.Paused);
}

async function handleResumeItem(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  await workGraph.transitionState(item.id, WorkItemState.InProgress);
}

async function handleBlockItem(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  await workGraph.transitionState(item.id, WorkItemState.Blocked);
}

async function handleUnblockItem(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  await workGraph.transitionState(item.id, WorkItemState.InProgress);
}

async function handleMarkWaitingOn(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  await workGraph.transitionState(item.id, WorkItemState.WaitingOn);
}

function handleEditItem(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  item?: { id?: string },
): void {
  if (!item?.id) { return; }
  const workItem = workGraph.getItem(item.id);
  if (workItem) {
    WorkItemEditorPanel.open(context, workGraph, workItem);
  }
}

async function handleOpenInBrowser(workGraph: WorkGraph, item?: { id?: string; url?: string }): Promise<void> {
  if (!item?.id) {
    vscode.window.showWarningMessage('WorkCenter: Select an item to open in the browser.');
    return;
  }
  const workItem = workGraph.getItem(item.id);
  const url = workItem?.url ?? item.url;
  if (!url) {
    vscode.window.showWarningMessage('This item has no URL to open.');
    return;
  }
  const uri = vscode.Uri.parse(url);
  if (uri.scheme !== 'http' && uri.scheme !== 'https') {
    vscode.window.showWarningMessage(`Cannot open non-web URL: ${url}`);
    return;
  }
  const opened = await vscode.env.openExternal(uri);
  if (!opened) {
    vscode.window.showWarningMessage('Failed to open URL in the browser.');
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
    vscode.window.showInformationMessage('No actions available for this item.');
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
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Action "${selected.label}" failed — ${message}`);
      }
    }
  }
}

async function handleMoveUp(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) {
    vscode.window.showInformationMessage('WorkCenter: Select an item in the Queue to move.');
    return;
  }
  await workGraph.moveItem(item.id, 'up');
}

async function handleMoveDown(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) {
    vscode.window.showInformationMessage('WorkCenter: Select an item in the Queue to move.');
    return;
  }
  await workGraph.moveItem(item.id, 'down');
}

async function handleAcceptFromInbox(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item?: InboxItem,
): Promise<void> {
  if (!item?.providerId || !item?.externalId) { return; }
  logger.info(`Accepting inbox item: ${item.externalId} from ${item.providerId}`);
  const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
  if (existing) {
    vscode.window.showInformationMessage(
      `WorkCenter: Item already accepted as "${existing.title}"`
    );
    return;
  }
  await workGraph.createItem(
    { title: formatItemTitle(item) },
    { providerId: item.providerId, externalId: item.externalId, url: item.url },
  );
  try {
    await stateStore.setState(item.providerId, item.externalId, 'accepted');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`WorkCenter: Failed to update state — ${message}`);
  }
}

async function handleDismissFromInbox(
  stateStore: DiscoveredStateStore,
  item?: InboxItem,
): Promise<void> {
  if (!item?.providerId || !item?.externalId) { return; }
  logger.info(`Dismissing inbox item: ${item.externalId}`);
  try {
    await stateStore.setState(item.providerId, item.externalId, 'dismissed');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`WorkCenter: Failed to dismiss item — ${message}`);
  }
}

async function handleAcceptFromSources(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  item?: SourceItemNode,
): Promise<void> {
  if (!item?.providerId || !item?.externalId) { return; }
  logger.info(`Accepting sources item: ${item.externalId}`);
  const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
  if (existing) {
    try {
      await stateStore.setState(item.providerId, item.externalId, 'accepted');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`WorkCenter: Failed to update state — ${message}`);
    }
    vscode.window.showInformationMessage(
      `WorkCenter: Item already accepted as "${existing.title}"`
    );
    return;
  }
  try {
    await workGraph.createItem(
      { title: formatItemTitle(item) },
      { providerId: item.providerId, externalId: item.externalId, url: item.url },
    );
    await stateStore.setState(item.providerId, item.externalId, 'accepted');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`WorkCenter: Failed to accept item — ${message}`);
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
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('workcenter.createItem', () =>
      handleCreateItem(workGraph)),
    vscode.commands.registerCommand('workcenter.acceptToFocus', (item) =>
      handleAcceptToFocus(workGraph, item)),
    vscode.commands.registerCommand('workcenter.archiveItem', (item) =>
      handleArchiveItem(workGraph, item)),
    vscode.commands.registerCommand('workcenter.completeItem', (item) =>
      handleCompleteItem(workGraph, item)),
    vscode.commands.registerCommand('workcenter.pauseItem', (item) =>
      handlePauseItem(workGraph, item)),
    vscode.commands.registerCommand('workcenter.resumeItem', (item) =>
      handleResumeItem(workGraph, item)),
    vscode.commands.registerCommand('workcenter.blockItem', (item) =>
      handleBlockItem(workGraph, item)),
    vscode.commands.registerCommand('workcenter.unblockItem', (item) =>
      handleUnblockItem(workGraph, item)),
    vscode.commands.registerCommand('workcenter.markWaitingOn', (item) =>
      handleMarkWaitingOn(workGraph, item)),
    vscode.commands.registerCommand('workcenter.editItem', (item) =>
      handleEditItem(context, workGraph, item)),
    vscode.commands.registerCommand('workcenter.openInBrowser', (item) =>
      handleOpenInBrowser(workGraph, item)),
    vscode.commands.registerCommand('workcenter.runAction', (item) =>
      handleRunAction(workGraph, actionRegistry, item)),
    vscode.commands.registerCommand('workcenter.moveUp', (item) =>
      handleMoveUp(workGraph, item)),
    vscode.commands.registerCommand('workcenter.moveDown', (item) =>
      handleMoveDown(workGraph, item)),
    vscode.commands.registerCommand('workcenter.acceptFromInbox', (item: InboxItem) =>
      handleAcceptFromInbox(workGraph, stateStore, item)),
    vscode.commands.registerCommand('workcenter.dismissFromInbox', (item: InboxItem) =>
      handleDismissFromInbox(stateStore, item)),
    vscode.commands.registerCommand('workcenter.acceptFromSources', (item: SourceItemNode) =>
      handleAcceptFromSources(workGraph, stateStore, item)),
  );
}
