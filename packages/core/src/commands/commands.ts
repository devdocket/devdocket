import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ActionRegistry } from '../services/actionRegistry';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { InboxItem } from '../views/inboxTreeProvider';
import { SourceItemNode } from '../views/sourcesTreeProvider';
import { logger } from '../services/logger';
import { toggleViewLayout } from '../views/viewLayout';

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
  void vscode.window.showErrorMessage(`WorkCenter: ${context} — ${detail}`);
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
  void vscode.window.showInformationMessage(`WorkCenter: Created "${title.trim()}"`);
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

async function handleMoveToQueue(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) { return; }
  await workGraph.transitionState(item.id, WorkItemState.New);
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
  if (!item || (!item.id && !item.url)) {
    void vscode.window.showWarningMessage('WorkCenter: Select an item to open in the browser.');
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
        void vscode.window.showErrorMessage(`WorkCenter: Action "${selected.label}" failed — ${detail}`);
      }
    }
  }
}

async function handleMoveUp(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) {
    void vscode.window.showInformationMessage('WorkCenter: Select an item in the Queue to move.');
    return;
  }
  await workGraph.moveItem(item.id, 'up');
}

async function handleMoveDown(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  if (!item?.id) {
    void vscode.window.showInformationMessage('WorkCenter: Select an item in the Queue to move.');
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
  let createdItem: Awaited<ReturnType<typeof workGraph.createItem>>;
  try {
    createdItem = await workGraph.createItem(
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
    // Roll back the created work item to prevent it appearing in Queue while still unseen in Inbox
    try {
      await workGraph.deleteItem(createdItem.id);
    } catch (rollbackErr: unknown) {
      logger.error('Failed to roll back created item after setState failure', rollbackErr);
    }
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
  let createdItem: Awaited<ReturnType<typeof workGraph.createItem>>;
  try {
    createdItem = await workGraph.createItem(
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
    // Roll back the created work item to prevent it appearing in Queue while still unseen in Sources
    try {
      await workGraph.deleteItem(createdItem.id);
    } catch (rollbackErr: unknown) {
      logger.error('Failed to roll back created item after setState failure', rollbackErr);
    }
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
    vscode.commands.registerCommand('workcenter.createItem',
      wrapCommand('Failed to create item', () => handleCreateItem(workGraph))),
    vscode.commands.registerCommand('workcenter.acceptToFocus',
      wrapCommand('Failed to focus item', (item) => handleAcceptToFocus(workGraph, item))),
    vscode.commands.registerCommand('workcenter.archiveItem',
      wrapCommand('Failed to archive item', (item) => handleArchiveItem(workGraph, item))),
    vscode.commands.registerCommand('workcenter.completeItem',
      wrapCommand('Failed to complete item', (item) => handleCompleteItem(workGraph, item))),
    vscode.commands.registerCommand('workcenter.pauseItem',
      wrapCommand('Failed to pause item', (item) => handlePauseItem(workGraph, item))),
    vscode.commands.registerCommand('workcenter.resumeItem',
      wrapCommand('Failed to resume item', (item) => handleResumeItem(workGraph, item))),
    vscode.commands.registerCommand('workcenter.editItem',
      wrapCommand('Failed to open editor', (item) => handleEditItem(context, workGraph, item))),
    vscode.commands.registerCommand('workcenter.openInBrowser',
      wrapCommand('Failed to open in browser', (item) => handleOpenInBrowser(workGraph, item))),
    vscode.commands.registerCommand('workcenter.runAction',
      wrapCommand('Failed to run action', (item) => handleRunAction(workGraph, actionRegistry, item))),
    vscode.commands.registerCommand('workcenter.moveUp',
      wrapCommand('Failed to move item up', (item) => handleMoveUp(workGraph, item))),
    vscode.commands.registerCommand('workcenter.moveDown',
      wrapCommand('Failed to move item down', (item) => handleMoveDown(workGraph, item))),
    vscode.commands.registerCommand('workcenter.moveToQueue',
      wrapCommand('Failed to move item to queue', (item) => handleMoveToQueue(workGraph, item))),
    vscode.commands.registerCommand('workcenter.acceptFromInbox',
      wrapCommand('Failed to accept from inbox', (item: InboxItem) => handleAcceptFromInbox(workGraph, stateStore, item))),
    vscode.commands.registerCommand('workcenter.dismissFromInbox',
      wrapCommand('Failed to dismiss from inbox', (item: InboxItem) => handleDismissFromInbox(stateStore, item))),
    vscode.commands.registerCommand('workcenter.acceptFromSources',
      wrapCommand('Failed to accept from sources', (item: SourceItemNode) => handleAcceptFromSources(workGraph, stateStore, item))),
    vscode.commands.registerCommand('workcenter.toggleInboxLayout',
      wrapCommand('Failed to toggle inbox layout', () => toggleViewLayout('inbox'))),
    vscode.commands.registerCommand('workcenter.toggleQueueLayout',
      wrapCommand('Failed to toggle queue layout', () => toggleViewLayout('queue'))),
    vscode.commands.registerCommand('workcenter.toggleFocusLayout',
      wrapCommand('Failed to toggle focus layout', () => toggleViewLayout('focus'))),
    vscode.commands.registerCommand('workcenter.toggleHistoryLayout',
      wrapCommand('Failed to toggle history layout', () => toggleViewLayout('history'))),
    vscode.commands.registerCommand('workcenter.toggleSourcesLayout',
      wrapCommand('Failed to toggle sources layout', () => toggleViewLayout('sources'))),
  );
}
