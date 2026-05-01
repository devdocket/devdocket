import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { wrapCommand, resolveItemIds, batchTransition } from './commandUtils';

async function handleArchiveItem(workGraph: WorkGraph, item?: { id?: string }, selectedItems?: { id?: string }[]): Promise<void> {
  const ids = resolveItemIds(item, selectedItems);
  if (ids.length === 0) { return; }
  await batchTransition(workGraph, ids, WorkItemState.Archived,
    (n) => `Archived ${n} item${n === 1 ? '' : 's'}`);
}

async function handleClearHistory(workGraph: WorkGraph): Promise<void> {
  const config = vscode.workspace.getConfiguration('devDocket');
  const raw = config.get<number>('historyClearDays', 30);
  const maxAgeDays = Number.isFinite(raw) && raw >= 1 ? Math.ceil(raw) : 30;

  const confirm = await vscode.window.showWarningMessage(
    `Delete all history items older than ${maxAgeDays} day${maxAgeDays === 1 ? '' : 's'}? This cannot be undone.`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') { return; }

  const result = await workGraph.clearOldHistory(maxAgeDays);
  if (result.failed > 0) {
    void vscode.window.showErrorMessage(
      `DevDocket: Failed to delete ${result.failed} item(s); see Output for details`,
    );
  }
  if (result.deleted > 0) {
    void vscode.window.showInformationMessage(`DevDocket: Cleared ${result.deleted} old history item${result.deleted === 1 ? '' : 's'}`);
  } else if (result.failed === 0) {
    void vscode.window.showInformationMessage('DevDocket: No history items older than the threshold');
  }
}

export function registerHistoryCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devdocket.archiveItem',
      wrapCommand('Failed to archive item', (item, selectedItems) => handleArchiveItem(workGraph, item, selectedItems))),
    vscode.commands.registerCommand('devdocket.clearHistory',
      wrapCommand('Failed to clear history', () => handleClearHistory(workGraph))),
  );
}
