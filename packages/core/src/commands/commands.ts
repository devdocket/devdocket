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

export function registerCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  actionRegistry: ActionRegistry,
  stateStore: DiscoveredStateStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('workcenter.createItem', () => createItem(workGraph)),
    vscode.commands.registerCommand('workcenter.acceptToFocus', async (item) => {
      try {
        await workGraph.transitionState(item.id, WorkItemState.InProgress);
      } catch (err: unknown) {
        logger.error('Failed to accept item to focus', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to update item — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.archiveItem', async (item) => {
      try {
        await workGraph.transitionState(item.id, WorkItemState.Archived);
      } catch (err: unknown) {
        logger.error('Failed to archive item', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to update item — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.completeItem', async (item) => {
      try {
        await workGraph.transitionState(item.id, WorkItemState.Done);
      } catch (err: unknown) {
        logger.error('Failed to complete item', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to update item — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.blockItem', async (item) => {
      try {
        await workGraph.transitionState(item.id, WorkItemState.Blocked);
      } catch (err: unknown) {
        logger.error('Failed to block item', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to update item — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.unblockItem', async (item) => {
      try {
        await workGraph.transitionState(item.id, WorkItemState.InProgress);
      } catch (err: unknown) {
        logger.error('Failed to unblock item', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to update item — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.markWaitingOn', async (item) => {
      try {
        await workGraph.transitionState(item.id, WorkItemState.WaitingOn);
      } catch (err: unknown) {
        logger.error('Failed to mark item as waiting', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to update item — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.editItem', (item) => {
      try {
        const workItem = workGraph.getItem(item.id);
        if (workItem) {
          WorkItemEditorPanel.open(context, workGraph, workItem);
        }
      } catch (err: unknown) {
        logger.error('Failed to open item editor', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to open editor — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.openInBrowser', (item) => {
      try {
        const workItem = workGraph.getItem(item.id);
        if (workItem?.url) {
          vscode.env.openExternal(vscode.Uri.parse(workItem.url));
        } else if (item.url) {
          vscode.env.openExternal(vscode.Uri.parse(item.url));
        }
      } catch (err: unknown) {
        logger.error('Failed to open item in browser', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to open in browser — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.runAction', async (item) => {
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
      } catch (err: unknown) {
        logger.error('Failed to run action', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to run action — ${message}`);
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
        logger.error('Failed to move item up', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to move item — ${message}`);
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
        logger.error('Failed to move item down', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to move item — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.acceptFromInbox', async (item: InboxItem) => {
      try {
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
        await stateStore.setState(item.providerId, item.externalId, 'accepted');
      } catch (err: unknown) {
        logger.error('Failed to accept inbox item', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to accept item — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.dismissFromInbox', async (item: InboxItem) => {
      try {
        logger.info(`Dismissing inbox item: ${item.externalId}`);
        await stateStore.setState(item.providerId, item.externalId, 'dismissed');
      } catch (err: unknown) {
        logger.error('Failed to dismiss inbox item', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to dismiss item — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.acceptFromSources', async (item: SourceItemNode) => {
      try {
        logger.info(`Accepting sources item: ${item.externalId}`);
        const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
        if (existing) {
          await stateStore.setState(item.providerId, item.externalId, 'accepted');
          vscode.window.showInformationMessage(
            `WorkCenter: Item already accepted as "${existing.title}"`
          );
          return;
        }
        await workGraph.createItem(
          { title: formatItemTitle(item) },
          { providerId: item.providerId, externalId: item.externalId, url: item.url },
        );
        await stateStore.setState(item.providerId, item.externalId, 'accepted');
      } catch (err: unknown) {
        logger.error('Failed to accept sources item', err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to accept item — ${message}`);
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
    logger.error('Failed to create work item', err);
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`WorkCenter: Failed to create item — ${message}`);
  }
}
