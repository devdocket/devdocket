import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';

export function registerCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
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

  await workGraph.createItem({ title: title.trim() });
  vscode.window.showInformationMessage(`WorkCenter: Created "${title.trim()}"`);
}
