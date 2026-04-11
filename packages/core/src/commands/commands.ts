import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ActionRegistry } from '../services/actionRegistry';
import { DiscoveredStateStore, type InboxState } from '../storage/discoveredStateStore';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { InboxItem, type InboxElement } from '../views/inboxTreeProvider';
import { SourceItemNode } from '../views/sourcesTreeProvider';
import { logger } from '../services/logger';

/**
 * Resolves the effective list of inbox items from VS Code's multi-select command args.
 * When canSelectMany is enabled, VS Code passes InboxElement (the union type) in
 * selectedItems, which may include provider/group nodes — we filter to leaf items only.
 */
function resolveInboxItems(item?: InboxElement, selectedItems?: InboxElement[]): InboxItem[] {
  if (selectedItems && selectedItems.length > 0) {
    return selectedItems.filter((i): i is InboxItem => i.kind === 'item' && !!i.providerId);
  }
  if (item && item.kind === 'item' && item.providerId && item.externalId) {
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
  item?: InboxElement,
  selectedItems?: InboxElement[],
): Promise<void> {
  const items = resolveInboxItems(item, selectedItems);
  if (items.length === 0) { return; }

  if (items.length === 1) {
    await acceptSingleInboxItem(workGraph, stateStore, items[0]);
    return;
  }

  // Batch accept: create work items, then batch-set states
  const stateUpdates: Array<{ providerId: string; externalId: string; state: InboxState }> = [];
  const createdIds: string[] = [];
  let failed = 0;

  for (const inboxItem of items) {
    const existing = workGraph.findItemByProvenance(inboxItem.providerId, inboxItem.externalId);
    if (existing) {
      stateUpdates.push({ providerId: inboxItem.providerId, externalId: inboxItem.externalId, state: 'accepted' });
      continue;
    }
    try {
      const createdItem = await workGraph.createItem(
        { title: formatItemTitle(inboxItem) },
        { providerId: inboxItem.providerId, externalId: inboxItem.externalId, url: inboxItem.url },
      );
      createdIds.push(createdItem.id);
      stateUpdates.push({ providerId: inboxItem.providerId, externalId: inboxItem.externalId, state: 'accepted' });
    } catch (err: unknown) {
      failed++;
      handleCommandError(`Failed to accept inbox item "${inboxItem.title}"`, err);
    }
  }

  if (stateUpdates.length > 0) {
    try {
      await stateStore.setStates(stateUpdates);
    } catch (err: unknown) {
      // Roll back all created work items
      for (const id of createdIds) {
        try { await workGraph.deleteItem(id); } catch (rollbackErr: unknown) {
          logger.error('Failed to roll back created item after batch setState failure', rollbackErr);
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
    vscode.commands.registerCommand('workcenter.acceptFromInbox',
      wrapCommand('Failed to accept from inbox', (item: InboxElement, selectedItems?: InboxElement[]) => handleAcceptFromInbox(workGraph, stateStore, item, selectedItems))),
    vscode.commands.registerCommand('workcenter.dismissFromInbox',
      wrapCommand('Failed to dismiss from inbox', (item: InboxElement, selectedItems?: InboxElement[]) => handleDismissFromInbox(stateStore, item, selectedItems))),
    vscode.commands.registerCommand('workcenter.acceptFromSources',
      wrapCommand('Failed to accept from sources', (item: SourceItemNode) => handleAcceptFromSources(workGraph, stateStore, item))),
  );
}
