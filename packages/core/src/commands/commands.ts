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

/** Log the error and show a user-facing message. */
function handleCommandError(context: string, err: unknown): void {
  logger.error(context, err);
  const detail = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(`WorkCenter: ${context} — ${detail}`);
}

// ---------------------------------------------------------------------------
// Individual command handlers
// ---------------------------------------------------------------------------

async function handleCreateItem(workGraph: WorkGraph): Promise<void> {
  try {
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
    void vscode.window.showInformationMessage(`WorkCenter: Created "${title.trim()}"`);
  } catch (err: unknown) {
    handleCommandError('Failed to create item', err);
  }
}

async function handleAcceptToFocus(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  try {
    await workGraph.transitionState(item.id, WorkItemState.InProgress);
  } catch (err: unknown) {
    handleCommandError('Failed to focus item', err);
  }
}

async function handleArchiveItem(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  try {
    await workGraph.transitionState(item.id, WorkItemState.Archived);
  } catch (err: unknown) {
    handleCommandError('Failed to archive item', err);
  }
}

async function handleCompleteItem(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  try {
    await workGraph.transitionState(item.id, WorkItemState.Done);
  } catch (err: unknown) {
    handleCommandError('Failed to complete item', err);
  }
}

async function handlePauseItem(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  try {
    await workGraph.transitionState(item.id, WorkItemState.Paused);
  } catch (err: unknown) {
    handleCommandError('Failed to pause item', err);
  }
}

async function handleResumeItem(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  try {
    await workGraph.transitionState(item.id, WorkItemState.InProgress);
  } catch (err: unknown) {
    handleCommandError('Failed to resume item', err);
  }
}

async function handleBlockItem(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  try {
    await workGraph.transitionState(item.id, WorkItemState.Blocked);
  } catch (err: unknown) {
    handleCommandError('Failed to block item', err);
  }
}

async function handleUnblockItem(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  try {
    await workGraph.transitionState(item.id, WorkItemState.InProgress);
  } catch (err: unknown) {
    handleCommandError('Failed to unblock item', err);
  }
}

async function handleMarkWaitingOn(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  try {
    await workGraph.transitionState(item.id, WorkItemState.WaitingOn);
  } catch (err: unknown) {
    handleCommandError('Failed to mark item as waiting', err);
  }
}

function handleEditItem(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  item?: { id?: string },
): void {
  if (!item?.id) { return; }
  try {
    const workItem = workGraph.getItem(item.id);
    if (workItem) {
      WorkItemEditorPanel.open(context, workGraph, workItem);
    }
  } catch (err: unknown) {
    handleCommandError('Failed to open editor', err);
  }
}

async function handleOpenInBrowser(workGraph: WorkGraph, item?: { id?: string; url?: string }): Promise<void> {
  if (!item?.id) {
    vscode.window.showWarningMessage('WorkCenter: Select an item to open in the browser.');
    return;
  }
  try {
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
  } catch (err: unknown) {
    handleCommandError('Failed to open in browser', err);
  }
}

async function handleRunAction(
  workGraph: WorkGraph,
  actionRegistry: ActionRegistry,
  item?: { id?: string },
): Promise<void> {
  if (!item?.id) { return; }
  try {
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
          void vscode.window.showErrorMessage(`WorkCenter: Action "${selected.label}" failed — ${detail}`);
        }
      }
    }
  } catch (err: unknown) {
    handleCommandError('Failed to run action', err);
  }
}

async function handleMoveUp(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  try {
    if (!item?.id) {
      void vscode.window.showInformationMessage('WorkCenter: Select an item in the Queue to move.');
      return;
    }
    await workGraph.moveItem(item.id, 'up');
  } catch (err: unknown) {
    handleCommandError('Failed to move item up', err);
  }
}

async function handleMoveDown(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  try {
    if (!item?.id) {
      void vscode.window.showInformationMessage('WorkCenter: Select an item in the Queue to move.');
      return;
    }
    await workGraph.moveItem(item.id, 'down');
  } catch (err: unknown) {
    handleCommandError('Failed to move item down', err);
  }
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
    void vscode.window.showInformationMessage(
      `WorkCenter: Item already accepted as "${existing.title}"`
    );
    try {
      await stateStore.setState(item.providerId, item.externalId, 'accepted');
    } catch (err: unknown) {
      handleCommandError('Failed to update state for existing accepted item', err);
    }
    return;
  }
  try {
    await workGraph.createItem(
      { title: formatItemTitle(item) },
      { providerId: item.providerId, externalId: item.externalId, url: item.url },
    );
  } catch (err: unknown) {
    handleCommandError('Failed to accept inbox item', err);
    return;
  }
  try {
    await stateStore.setState(item.providerId, item.externalId, 'accepted');
  } catch (err: unknown) {
    handleCommandError('Failed to update state after accepting item', err);
  }
}

async function handleDismissFromInbox(
  stateStore: DiscoveredStateStore,
  item?: InboxItem,
): Promise<void> {
  if (!item?.providerId || !item?.externalId) { return; }
  try {
    logger.info(`Dismissing inbox item: ${item.externalId}`);
    await stateStore.setState(item.providerId, item.externalId, 'dismissed');
  } catch (err: unknown) {
    handleCommandError('Failed to dismiss item', err);
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
      handleCommandError('Failed to update state for existing item', err);
    }
    void vscode.window.showInformationMessage(
      `WorkCenter: Item already accepted as "${existing.title}"`
    );
    return;
  }
  try {
    await workGraph.createItem(
      { title: formatItemTitle(item) },
      { providerId: item.providerId, externalId: item.externalId, url: item.url },
    );
  } catch (err: unknown) {
    handleCommandError('Failed to accept sources item', err);
    return;
  }
  try {
    await stateStore.setState(item.providerId, item.externalId, 'accepted');
  } catch (err: unknown) {
    handleCommandError('Failed to update state after accepting item', err);
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
