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

/** Build a command handler that transitions a work item's state. */
function transitionCommand(
  workGraph: WorkGraph,
  targetState: WorkItemState,
  failureContext: string,
): (item?: { id?: string }) => Promise<void> {
  return async (item) => {
    if (!item?.id) {
      vscode.window.showInformationMessage('WorkCenter: Select a work item first.');
      return;
    }
    try {
      await workGraph.transitionState(item.id, targetState);
    } catch (err: unknown) {
      handleCommandError(failureContext, err);
    }
  };
}

export function registerCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  actionRegistry: ActionRegistry,
  stateStore: DiscoveredStateStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('workcenter.createItem', () => createItem(workGraph)),
    vscode.commands.registerCommand(
      'workcenter.acceptToFocus',
      transitionCommand(workGraph, WorkItemState.InProgress, 'Failed to focus item'),
    ),
    vscode.commands.registerCommand(
      'workcenter.archiveItem',
      transitionCommand(workGraph, WorkItemState.Archived, 'Failed to archive item'),
    ),
    vscode.commands.registerCommand(
      'workcenter.completeItem',
      transitionCommand(workGraph, WorkItemState.Done, 'Failed to complete item'),
    ),
    vscode.commands.registerCommand(
      'workcenter.blockItem',
      transitionCommand(workGraph, WorkItemState.Blocked, 'Failed to block item'),
    ),
    vscode.commands.registerCommand(
      'workcenter.unblockItem',
      transitionCommand(workGraph, WorkItemState.InProgress, 'Failed to unblock item'),
    ),
    vscode.commands.registerCommand(
      'workcenter.markWaitingOn',
      transitionCommand(workGraph, WorkItemState.WaitingOn, 'Failed to mark item as waiting'),
    ),
    vscode.commands.registerCommand('workcenter.editItem', (item) => {
      if (!item?.id) {
        vscode.window.showInformationMessage('WorkCenter: Select a work item first.');
        return;
      }
      try {
        const workItem = workGraph.getItem(item.id);
        if (workItem) {
          WorkItemEditorPanel.open(context, workGraph, workItem);
        }
      } catch (err: unknown) {
        handleCommandError('Failed to open editor', err);
      }
    }),
    vscode.commands.registerCommand('workcenter.openInBrowser', (item) => {
      if (!item?.id && !item?.url) {
        vscode.window.showInformationMessage('WorkCenter: Select a work item first.');
        return;
      }
      try {
        const workItem = item?.id ? workGraph.getItem(item.id) : undefined;
        if (workItem?.url) {
          vscode.env.openExternal(vscode.Uri.parse(workItem.url));
        } else if (item.url) {
          vscode.env.openExternal(vscode.Uri.parse(item.url));
        }
      } catch (err: unknown) {
        handleCommandError('Failed to open in browser', err);
      }
    }),
    vscode.commands.registerCommand('workcenter.runAction', async (item) => {
      if (!item?.id) {
        vscode.window.showInformationMessage('WorkCenter: Select a work item first.');
        return;
      }
      // Outer: guards registry/UI lookup errors
      try {
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
            // Inner: guards action execution with action-specific error message
            try {
              logger.info(`Running action: ${selected.actionId} on item ${workItem.id}`);
              await action.run(workItem);
            } catch (err: unknown) {
              logger.error('Action failed: ' + selected.label, err);
              const detail = err instanceof Error ? err.message : String(err);
              vscode.window.showErrorMessage(`WorkCenter: Action "${selected.label}" failed — ${detail}`);
            }
          }
        }
      } catch (err: unknown) {
        handleCommandError('Failed to run action', err);
      }
    }),
    vscode.commands.registerCommand('workcenter.moveUp', async (item) => {
      try {
        if (!item?.id) {
          vscode.window.showInformationMessage('WorkCenter: Select an item in the Queue to move.');
          return;
        }
        await workGraph.moveItem(item.id, 'up');
      } catch (err: unknown) {
        handleCommandError('Failed to move item up', err);
      }
    }),
    vscode.commands.registerCommand('workcenter.moveDown', async (item) => {
      try {
        if (!item?.id) {
          vscode.window.showInformationMessage('WorkCenter: Select an item in the Queue to move.');
          return;
        }
        await workGraph.moveItem(item.id, 'down');
      } catch (err: unknown) {
        handleCommandError('Failed to move item down', err);
      }
    }),
    vscode.commands.registerCommand('workcenter.acceptFromInbox', async (item: InboxItem) => {
      if (!item?.providerId || !item?.externalId) {
        vscode.window.showInformationMessage('WorkCenter: Select an item in the Inbox first.');
        return;
      }
      logger.info(`Accepting inbox item: ${item.externalId} from ${item.providerId}`);
      const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
      if (existing) {
        vscode.window.showInformationMessage(
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
    }),
    vscode.commands.registerCommand('workcenter.dismissFromInbox', async (item: InboxItem) => {
      if (!item?.providerId || !item?.externalId) {
        vscode.window.showInformationMessage('WorkCenter: Select an item in the Inbox first.');
        return;
      }
      try {
        logger.info(`Dismissing inbox item: ${item.externalId}`);
        await stateStore.setState(item.providerId, item.externalId, 'dismissed');
      } catch (err: unknown) {
        handleCommandError('Failed to dismiss item', err);
      }
    }),
    vscode.commands.registerCommand('workcenter.acceptFromSources', async (item: SourceItemNode) => {
      if (!item?.providerId || !item?.externalId) {
        vscode.window.showInformationMessage('WorkCenter: Select an item in Sources first.');
        return;
      }
      logger.info(`Accepting sources item: ${item.externalId}`);
      const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
      if (existing) {
        try {
          await stateStore.setState(item.providerId, item.externalId, 'accepted');
        } catch (err: unknown) {
          handleCommandError('Failed to update state for existing item', err);
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
      } catch (err: unknown) {
        handleCommandError('Failed to accept sources item', err);
        return;
      }
      try {
        await stateStore.setState(item.providerId, item.externalId, 'accepted');
      } catch (err: unknown) {
        handleCommandError('Failed to update state after accepting item', err);
      }
    }),
  );
}

async function createItem(workGraph: WorkGraph): Promise<void> {
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
    vscode.window.showInformationMessage(`WorkCenter: Created "${title.trim()}"`);
  } catch (err: unknown) {
    handleCommandError('Failed to create item', err);
  }
}
