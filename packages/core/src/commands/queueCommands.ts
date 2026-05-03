import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { logger } from '../services/logger';
import { wrapCommand, resolveItemIds, batchTransition, requireItemToMove } from './commandUtils';

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
  void vscode.window.showInformationMessage(`DevDocket: Created "${title.trim()}"`);
}

async function handleAcceptToFocus(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.InProgress,
    (n) => `Moved ${n} item${n === 1 ? '' : 's'} to In Progress`);
}

async function handleMoveUp(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  await requireItemToMove('the Ready to Start tier', item, id => workGraph.moveItem(id, 'up'));
}

async function handleMoveDown(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  await requireItemToMove('the Ready to Start tier', item, id => workGraph.moveItem(id, 'down'));
}

async function handleMoveToTop(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  await requireItemToMove('the Ready to Start tier', item, id => workGraph.moveToTop(id));
}

async function handleMoveToBottom(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  await requireItemToMove('the Ready to Start tier', item, id => workGraph.moveToBottom(id));
}

async function handleDeleteItem(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }

  const itemWord = ids.length === 1 ? 'item' : `${ids.length} items`;
  const confirm = await vscode.window.showWarningMessage(
    `Delete ${itemWord}? This cannot be undone.`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') { return; }

  if (ids.length === 1) {
    await workGraph.deleteItem(ids[0]);
    return;
  }
  const failedIds: string[] = [];
  for (const id of ids) {
    try {
      await workGraph.deleteItem(id);
    } catch (err: unknown) {
      failedIds.push(id);
      logger.error(`Failed to delete item ${id}`, err);
    }
  }
  const succeeded = ids.length - failedIds.length;
  if (succeeded > 0) {
    void vscode.window.showInformationMessage(`Deleted ${succeeded} item${succeeded === 1 ? '' : 's'}`);
  }
  if (failedIds.length > 0) {
    void vscode.window.showErrorMessage(
      `DevDocket: Failed to delete ${failedIds.length} item(s); see Output for details`,
    );
  }
}

export function registerQueueCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devdocket.createItem',
      wrapCommand('Failed to create item', () => handleCreateItem(workGraph))),
    vscode.commands.registerCommand('devdocket.acceptToFocus',
      wrapCommand('Failed to In Progress item', (item, selectedItems) => handleAcceptToFocus(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.moveUp',
      wrapCommand('Failed to move item up', (item) => handleMoveUp(workGraph, item))),
    vscode.commands.registerCommand('devdocket.moveDown',
      wrapCommand('Failed to move item down', (item) => handleMoveDown(workGraph, item))),
    vscode.commands.registerCommand('devdocket.moveToTop',
      wrapCommand('Failed to move item to top', (item) => handleMoveToTop(workGraph, item))),
    vscode.commands.registerCommand('devdocket.moveToBottom',
      wrapCommand('Failed to move item to bottom', (item) => handleMoveToBottom(workGraph, item))),
    vscode.commands.registerCommand('devdocket.deleteItem',
      wrapCommand('Failed to delete item', (item, selectedItems) => handleDeleteItem(workGraph, item, selectedItems))),
  );
}
