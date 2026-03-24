import * as vscode from 'vscode';
import { WorkCenterApi } from './api/types';
import { WorkCenterApiImpl } from './api/workCenterApi';
import { JsonTaskStore } from './storage/jsonTaskStore';
import { WorkGraph } from './services/workGraph';
import { ProviderRegistry } from './services/providerRegistry';
import { ActionRegistry } from './services/actionRegistry';
import { InboxTreeProvider } from './views/inboxTreeProvider';
import { FocusTreeProvider } from './views/focusTreeProvider';
import { registerCommands } from './commands/commands';

export type { WorkCenterApi, WorkCenterProvider, WorkCenterAction, DiscoveredItem, Disposable } from './api/types';

export async function activate(context: vscode.ExtensionContext): Promise<WorkCenterApi> {
  const storagePath = context.globalStorageUri.fsPath;
  const store = new JsonTaskStore(storagePath);
  const workGraph = new WorkGraph(store);

  await workGraph.load();

  const providerRegistry = new ProviderRegistry(workGraph);
  const actionRegistry = new ActionRegistry();
  const api = new WorkCenterApiImpl(providerRegistry, actionRegistry);

  const queueProvider = new InboxTreeProvider(workGraph);
  const focusProvider = new FocusTreeProvider(workGraph);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('workcenter.queue', queueProvider),
    vscode.window.registerTreeDataProvider('workcenter.focus', focusProvider),
    { dispose: () => workGraph.dispose() },
    { dispose: () => queueProvider.dispose() },
    { dispose: () => focusProvider.dispose() },
    { dispose: () => providerRegistry.dispose() },
    { dispose: () => actionRegistry.dispose() },
  );

  registerCommands(context, workGraph, actionRegistry);

  return api;
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
