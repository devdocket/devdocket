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
    vscode.commands.registerCommand('workcenter.acceptToFocus', (item) =>
      workGraph.transitionState(item.id, WorkItemState.InProgress),
    ),
    vscode.commands.registerCommand('workcenter.archiveItem', (item) =>
      workGraph.transitionState(item.id, WorkItemState.Archived),
    ),
    vscode.commands.registerCommand('workcenter.completeItem', (item) =>
      workGraph.transitionState(item.id, WorkItemState.Done),
    ),
    vscode.commands.registerCommand('workcenter.blockItem', (item) =>
      workGraph.transitionState(item.id, WorkItemState.Blocked),
    ),
    vscode.commands.registerCommand('workcenter.unblockItem', (item) =>
      workGraph.transitionState(item.id, WorkItemState.InProgress),
    ),
    vscode.commands.registerCommand('workcenter.markWaitingOn', (item) =>
      workGraph.transitionState(item.id, WorkItemState.WaitingOn),
    ),
    vscode.commands.registerCommand('workcenter.editItem', (item) => {
      const workItem = workGraph.getItem(item.id);
      if (workItem) {
        WorkItemEditorPanel.open(context, workGraph, workItem);
      }
    }),
    vscode.commands.registerCommand('workcenter.openInBrowser', (item) => {
      const workItem = workGraph.getItem(item.id);
      if (workItem?.url) {
        vscode.env.openExternal(vscode.Uri.parse(workItem.url));
      } else if (item.url) {
        vscode.env.openExternal(vscode.Uri.parse(item.url));
      }
    }),
    vscode.commands.registerCommand('workcenter.runAction', async (item) => {
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
    }),
    vscode.commands.registerCommand('workcenter.moveUp', (item) => {
      if (!item?.id) {
        vscode.window.showInformationMessage('WorkCenter: Select an item in the Queue to move.');
        return;
      }
      return workGraph.moveItem(item.id, 'up');
    }),
    vscode.commands.registerCommand('workcenter.moveDown', (item) => {
      if (!item?.id) {
        vscode.window.showInformationMessage('WorkCenter: Select an item in the Queue to move.');
        return;
      }
      return workGraph.moveItem(item.id, 'down');
    }),
    vscode.commands.registerCommand('workcenter.acceptFromInbox', async (item: InboxItem) => {
      logger.info(`Accepting inbox item: ${item.externalId} from ${item.providerId}`);
      const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
      if (existing) {
        vscode.window.showInformationMessage(
          `WorkCenter: Item already accepted as "${existing.title}"`
        );
        return;
      }
      await workGraph.createItem(
        { title: formatItemTitle(item), description: item.description },
        { providerId: item.providerId, externalId: item.externalId, url: item.url },
      );
      try {
        await stateStore.setState(item.providerId, item.externalId, 'accepted');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to update state — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.dismissFromInbox', async (item: InboxItem) => {
      logger.info(`Dismissing inbox item: ${item.externalId}`);
      try {
        await stateStore.setState(item.providerId, item.externalId, 'dismissed');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to dismiss item — ${message}`);
      }
    }),
    vscode.commands.registerCommand('workcenter.acceptFromSources', async (item: SourceItemNode) => {
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
          { title: formatItemTitle(item), description: item.description },
          { providerId: item.providerId, externalId: item.externalId, url: item.url },
        );
        await stateStore.setState(item.providerId, item.externalId, 'accepted');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`WorkCenter: Failed to accept item — ${message}`);
      }
    }),
  );
}

async function createItem(workGraph: WorkGraph): Promise<void> {
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
