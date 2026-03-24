import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { ActionRegistry } from '../services/actionRegistry';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';

export function registerCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  actionRegistry: ActionRegistry,
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
      }
    }),
    vscode.commands.registerCommand('workcenter.runAction', async (item) => {
      const workItem = workGraph.getItem(item.id);
      if (!workItem) {
        return;
      }
      const actions = actionRegistry.getActionsFor(workItem);
      if (actions.length === 0) {
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
          await action.run(workItem);
        }
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
