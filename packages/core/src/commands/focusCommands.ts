import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { wrapCommand, resolveItemIds, batchTransition, requireItemToMove } from './commandUtils';

async function handleCompleteItem(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.Done,
    (n) => `Completed ${n} item${n === 1 ? '' : 's'}`);
}

async function handlePauseItem(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.Paused,
    (n) => `Paused ${n} item${n === 1 ? '' : 's'}`);
}

async function handleResumeItem(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.InProgress,
    (n) => `Resumed ${n} item${n === 1 ? '' : 's'}`);
}

async function handleMoveToQueue(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.New,
    (n) => `Moved ${n} item${n === 1 ? '' : 's'} to Ready to Start`);
}

async function handleFocusMoveUp(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  await requireItemToMove('the In Progress tier', item, id => workGraph.moveItem(id, 'up'));
}

async function handleFocusMoveDown(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  await requireItemToMove('the In Progress tier', item, id => workGraph.moveItem(id, 'down'));
}

async function handleFocusMoveToTop(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  await requireItemToMove('the In Progress tier', item, id => workGraph.moveToTop(id));
}

async function handleFocusMoveToBottom(workGraph: WorkGraph, item?: { id?: string }): Promise<void> {
  await requireItemToMove('the In Progress tier', item, id => workGraph.moveToBottom(id));
}

export function registerFocusCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devdocket.completeItem',
      wrapCommand('Failed to complete item', (item, selectedItems) => handleCompleteItem(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.pauseItem',
      wrapCommand('Failed to pause item', (item, selectedItems) => handlePauseItem(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.resumeItem',
      wrapCommand('Failed to resume item', (item, selectedItems) => handleResumeItem(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.moveToQueue',
      wrapCommand('Failed to move item to Ready to Start', (item, selectedItems) => handleMoveToQueue(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.focusMoveUp',
      wrapCommand('Failed to move focus item up', (item) => handleFocusMoveUp(workGraph, item))),
    vscode.commands.registerCommand('devdocket.focusMoveDown',
      wrapCommand('Failed to move focus item down', (item) => handleFocusMoveDown(workGraph, item))),
    vscode.commands.registerCommand('devdocket.focusMoveToTop',
      wrapCommand('Failed to move focus item to top', (item) => handleFocusMoveToTop(workGraph, item))),
    vscode.commands.registerCommand('devdocket.focusMoveToBottom',
      wrapCommand('Failed to move focus item to bottom', (item) => handleFocusMoveToBottom(workGraph, item))),
  );
}
