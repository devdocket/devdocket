import * as vscode from 'vscode';
import { JsonTaskStore } from './storage/jsonTaskStore';
import { WorkGraph } from './services/workGraph';
import { InboxTreeProvider } from './views/inboxTreeProvider';
import { FocusTreeProvider } from './views/focusTreeProvider';
import { registerCommands } from './commands/commands';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const storagePath = context.globalStorageUri.fsPath;
  const store = new JsonTaskStore(storagePath);
  const workGraph = new WorkGraph(store);

  await workGraph.load();

  const queueProvider = new InboxTreeProvider(workGraph);
  const focusProvider = new FocusTreeProvider(workGraph);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('workcenter.queue', queueProvider),
    vscode.window.registerTreeDataProvider('workcenter.focus', focusProvider),
    { dispose: () => workGraph.dispose() },
    { dispose: () => queueProvider.dispose() },
    { dispose: () => focusProvider.dispose() },
  );

  registerCommands(context, workGraph);
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
