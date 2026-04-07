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
import { initLogger, setLogLevel, logger, LogLevel } from './services/logger';
import { getInboxUnseenCount } from './services/inboxBadge';

export type { WorkCenterApi, WorkCenterProvider, WorkCenterAction, DiscoveredItem, Disposable } from './api/types';
export { logger } from './services/logger';

function initializeLogging(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('WorkCenter');
  context.subscriptions.push(outputChannel);

  const logLevelMap: Record<string, LogLevel> = {
    debug: LogLevel.Debug,
    info: LogLevel.Info,
    warn: LogLevel.Warn,
    error: LogLevel.Error,
  };
  const logLevelConfig = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
  initLogger(outputChannel, logLevelMap[logLevelConfig] ?? LogLevel.Info);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workcenter.logLevel')) {
        const newLevel = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
        setLogLevel(logLevelMap[newLevel] ?? LogLevel.Info);
      }
    }),
  );
}

async function loadStores(storagePath: string): Promise<{ workGraph: WorkGraph; stateStore: DiscoveredStateStore }> {
  const store = new JsonTaskStore(storagePath);
  const workGraph = new WorkGraph(store);
  await workGraph.load();
  logger.debug(`Loaded ${workGraph.getAll().length} work items`);

  const stateStore = new DiscoveredStateStore(storagePath);
  await stateStore.load();
  logger.debug('Loaded discovered state');

  return { workGraph, stateStore };
}

async function migrateDiscoveredState(workGraph: WorkGraph, stateStore: DiscoveredStateStore): Promise<void> {
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
      logger.info(`Migrated ${itemsToMigrate.length} items to accepted state`);
    } catch (err) {
      logger.error('Migration failed', err);
    }
  }
}

function createTreeViews(
  providerRegistry: ProviderRegistry,
  stateStore: DiscoveredStateStore,
  workGraph: WorkGraph,
) {
  const inboxProvider = new InboxTreeProvider(providerRegistry, stateStore);
  const queueProvider = new QueueTreeProvider(workGraph);
  const focusProvider = new FocusTreeProvider(workGraph);
  const sourcesProvider = new SourcesTreeProvider(providerRegistry, stateStore);
  const historyProvider = new HistoryTreeProvider(workGraph);

  const inboxTreeView = vscode.window.createTreeView('workcenter.inbox', { treeDataProvider: inboxProvider });
  const sourcesTreeView = vscode.window.createTreeView('workcenter.sources', { treeDataProvider: sourcesProvider });
  const queueTreeView = vscode.window.createTreeView('workcenter.queue', { treeDataProvider: queueProvider, dragAndDropController: queueProvider });
  const focusTreeView = vscode.window.createTreeView('workcenter.focus', { treeDataProvider: focusProvider });
  const historyTreeView = vscode.window.createTreeView('workcenter.history', { treeDataProvider: historyProvider });

  const inboxSelectionSub = inboxTreeView.onDidChangeSelection((e) => {
    let changed = false;
    for (const item of e.selection) {
      if (item.kind === 'item') {
        changed = inboxProvider.markSeen(item.providerId, item.externalId) || changed;
      }
    }
    if (changed) {
      inboxProvider.refresh();
    }
  });

  return {
    providers: { inboxProvider, queueProvider, focusProvider, sourcesProvider, historyProvider },
    views: { inboxTreeView, queueTreeView, focusTreeView, sourcesTreeView, historyTreeView },
    disposables: [inboxSelectionSub] as vscode.Disposable[],
  };
}

// Wires up all event-driven UI updates: view messages, inbox badge,
// coalesced provider events, and new-item notifications.
function wireEvents(
  providerRegistry: ProviderRegistry,
  stateStore: DiscoveredStateStore,
  workGraph: WorkGraph,
  { providers, views }: ReturnType<typeof createTreeViews>,
): vscode.Disposable[] {
  const { inboxProvider, queueProvider, focusProvider, historyProvider } = providers;
  const { inboxTreeView, sourcesTreeView, queueTreeView, focusTreeView, historyTreeView } = views;

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

  const updateWorkViewMessages = () => {
    queueTreeView.message = queueProvider.getChildren().length > 0 ? undefined : 'No items in queue';
    focusTreeView.message = focusProvider.getChildren().length > 0 ? undefined : 'No active work';
    historyTreeView.message = historyProvider.getChildren().length > 0 ? undefined : 'No history items';
  };

  let initialLoadComplete = false;
  let wasLoading = false;

  const updateInboxBadge = () => {
    const count = getInboxUnseenCount(providerRegistry, stateStore);
    inboxTreeView.badge = count > 0 ? { value: count, tooltip: `${count} unseen item${count === 1 ? '' : 's'}` } : undefined;
  };

  // Coalesce UI updates so that when both onDidChangeDiscoveredItems and
  // stateStore.onDidChange fire in the same microtask (e.g. during a discovery
  // batch that calls setStates), we only run the full unseen-count scan once.
  let uiUpdateScheduled = false;
  const scheduleUiUpdate = () => {
    if (uiUpdateScheduled) { return; }
    uiUpdateScheduled = true;
    queueMicrotask(() => {
      uiUpdateScheduled = false;
      updateViewMessages();
      updateInboxBadge();
    });
  };

  // Set initial state
  updateWorkViewMessages();
  updateViewMessages();
  updateInboxBadge();

  const providerRegSub = providerRegistry.onDidRegisterProvider(scheduleUiUpdate);
  const discoveredSub = providerRegistry.onDidChangeDiscoveredItems(() => {
    scheduleUiUpdate();

    // Mark initial load complete when loading transitions from true to false
    if (!initialLoadComplete) {
      if (wasLoading && !providerRegistry.loading) {
        initialLoadComplete = true;
      }
      wasLoading = wasLoading || providerRegistry.loading;
    }
  });
  const newItemsSub = providerRegistry.onDidAddNewUnseenItems((newCount) => {
    if (!initialLoadComplete) { return; }
    const config = vscode.workspace.getConfiguration('workcenter');
    const showNotifications = config.get<boolean>('showInboxNotifications', true);
    if (showNotifications && newCount > 0) {
      vscode.window.showInformationMessage(
        `WorkCenter: ${newCount} new item${newCount === 1 ? '' : 's'} in Inbox`
      );
    }
  });
  const stateStoreSub = stateStore.onDidChange(scheduleUiUpdate);
  const workGraphSub = workGraph.onDidChange(updateWorkViewMessages);

  return [discoveredSub, newItemsSub, providerRegSub, stateStoreSub, workGraphSub];
}

/**
 * Activate the WorkCenter extension.
 *
 * Initialises storage, loads persisted work items and discovered-item state,
 * registers all tree views (Inbox, Queue, Focus, History, Sources), and
 * returns the public {@link WorkCenterApi} for provider extensions to consume.
 *
 * @param context - The VS Code extension context provided at activation.
 * @returns The public API used by provider extensions to register providers and actions.
 */
export async function activate(context: vscode.ExtensionContext): Promise<WorkCenterApi> {
  initializeLogging(context);
  logger.info('WorkCenter activating...');

  const storagePath = context.globalStorageUri.fsPath;
  const { workGraph, stateStore } = await loadStores(storagePath);
  await migrateDiscoveredState(workGraph, stateStore);

  const providerRegistry = new ProviderRegistry(stateStore);
  const actionRegistry = new ActionRegistry();
  const api = new WorkCenterApiImpl(providerRegistry, actionRegistry);

  const treeSetup = createTreeViews(providerRegistry, stateStore, workGraph);
  const eventDisposables = wireEvents(providerRegistry, stateStore, workGraph, treeSetup);

  const { providers, views, disposables: viewDisposables } = treeSetup;

  context.subscriptions.push(
    ...Object.values(views),
    ...viewDisposables,
    ...eventDisposables,
    { dispose: () => workGraph.dispose() },
    { dispose: () => stateStore.dispose() },
    { dispose: () => providers.inboxProvider.dispose() },
    { dispose: () => providers.queueProvider.dispose() },
    { dispose: () => providers.focusProvider.dispose() },
    { dispose: () => providers.sourcesProvider.dispose() },
    { dispose: () => providers.historyProvider.dispose() },
    { dispose: () => providerRegistry.dispose() },
    { dispose: () => actionRegistry.dispose() },
  );

  registerCommands(context, workGraph, actionRegistry, stateStore);

  logger.info('WorkCenter activated');
  return api;
}

/**
 * Deactivate the WorkCenter extension.
 *
 * All resources are disposed automatically via `context.subscriptions`,
 * so this function is intentionally a no-op.
 */
export function deactivate(): void {
  // Resources disposed via subscriptions
}
