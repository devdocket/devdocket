import * as vscode from 'vscode';
import { WorkCenterApi } from './api/types';
import { WorkCenterApiImpl } from './api/workCenterApi';
import { JsonTaskStore } from './storage/jsonTaskStore';
import { DiscoveredStateStore } from './storage/discoveredStateStore';
import { WorkGraph } from './services/workGraph';
import { ProviderRegistry } from './services/providerRegistry';
import { ActionRegistry } from './services/actionRegistry';
import { InboxTreeProvider } from './views/inboxTreeProvider';
import { QueueTreeProvider } from './views/queueTreeProvider';
import { FocusTreeProvider } from './views/focusTreeProvider';
import { SourcesTreeProvider } from './views/sourcesTreeProvider';
import { HistoryTreeProvider } from './views/historyTreeProvider';
import { registerCommands } from './commands/commands';

export type { WorkCenterApi, WorkCenterProvider, WorkCenterAction, DiscoveredItem, Disposable } from './api/types';

export async function activate(context: vscode.ExtensionContext): Promise<WorkCenterApi> {
  const storagePath = context.globalStorageUri.fsPath;
  const store = new JsonTaskStore(storagePath);
  const workGraph = new WorkGraph(store);
  await workGraph.load();

  const stateStore = new DiscoveredStateStore(storagePath);
  await stateStore.load();

  // Migration: mark existing provider-backed items as accepted
  const itemsToMigrate: Array<{ providerId: string; externalId: string; state: 'accepted' }> = [];
  
  for (const item of workGraph.getAll()) {
    if (item.providerId && item.externalId) {
      const existing = stateStore.getState(item.providerId, item.externalId);
      if (existing === undefined) {
        itemsToMigrate.push({
          providerId: item.providerId,
          externalId: item.externalId,
          state: 'accepted',
        });
      }
    }
  }

  if (itemsToMigrate.length > 0) {
    try {
      await stateStore.setStates(itemsToMigrate);
    } catch (err) {
      console.error('WorkCenter: migration failed:', err);
    }
  }

  const providerRegistry = new ProviderRegistry(stateStore);
  const actionRegistry = new ActionRegistry();
  const api = new WorkCenterApiImpl(providerRegistry, actionRegistry);

  const inboxProvider = new InboxTreeProvider(providerRegistry, stateStore);
  const queueProvider = new QueueTreeProvider(workGraph);
  const focusProvider = new FocusTreeProvider(workGraph);
  const sourcesProvider = new SourcesTreeProvider(providerRegistry, stateStore);
  const historyProvider = new HistoryTreeProvider(workGraph);

  const inboxTreeView = vscode.window.createTreeView('workcenter.inbox', { treeDataProvider: inboxProvider });
  const sourcesTreeView = vscode.window.createTreeView('workcenter.sources', { treeDataProvider: sourcesProvider });

  // View message state: empty by default, loading when providers are fetching
  const updateViewMessages = () => {
    if (providerRegistry.loading) {
      sourcesTreeView.message = 'Loading…';
      inboxTreeView.message = 'Loading…';
    } else if (providerRegistry.getAllDiscoveredItems().size === 0) {
      sourcesTreeView.message = 'No sources connected';
      inboxTreeView.message = 'No new items';
    } else {
      // Providers loaded — show empty messages only if views have no content
      const hasDiscoveredItems = [...providerRegistry.getAllDiscoveredItems().values()].some(items => items.length > 0);
      sourcesTreeView.message = hasDiscoveredItems ? undefined : 'No items found';

      const hasInboxItems = inboxProvider.getChildren().length > 0;
      inboxTreeView.message = hasInboxItems ? undefined : 'No new items';
    }
  };
  const queueTreeView = vscode.window.createTreeView('workcenter.queue', { treeDataProvider: queueProvider });
  const focusTreeView = vscode.window.createTreeView('workcenter.focus', { treeDataProvider: focusProvider });
  const historyTreeView = vscode.window.createTreeView('workcenter.history', { treeDataProvider: historyProvider });

  const updateWorkViewMessages = () => {
    queueTreeView.message = queueProvider.getChildren().length > 0 ? undefined : 'No items in queue';
    focusTreeView.message = focusProvider.getChildren().length > 0 ? undefined : 'No active work';
    historyTreeView.message = historyProvider.getChildren().length > 0 ? undefined : 'No completed items';
  };
  updateWorkViewMessages();
  const workGraphSub = workGraph.onDidChange(updateWorkViewMessages);

  updateViewMessages();

  const providerRegSub = providerRegistry.onDidRegisterProvider(updateViewMessages);
  const discoveredSub = providerRegistry.onDidChangeDiscoveredItems(updateViewMessages);
  const stateStoreSub = stateStore.onDidChange(updateViewMessages);

  context.subscriptions.push(
    inboxTreeView,
    queueTreeView,
    focusTreeView,
    sourcesTreeView,
    historyTreeView,
    discoveredSub,
    providerRegSub,
    stateStoreSub,
    workGraphSub,
    { dispose: () => workGraph.dispose() },
    { dispose: () => stateStore.dispose() },
    { dispose: () => inboxProvider.dispose() },
    { dispose: () => queueProvider.dispose() },
    { dispose: () => focusProvider.dispose() },
    { dispose: () => sourcesProvider.dispose() },
    { dispose: () => historyProvider.dispose() },
    { dispose: () => providerRegistry.dispose() },
    { dispose: () => actionRegistry.dispose() },
  );

  registerCommands(context, workGraph, actionRegistry, stateStore);

  return api;
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
