import * as vscode from 'vscode';
import { WorkCenterApi } from './api/types';
import { WorkCenterApiImpl } from './api/workCenterApi';
import { JsonTaskStore } from './storage/jsonTaskStore';
import { DiscoveredStateStore } from './storage/discoveredStateStore';
import { ReadStateStore } from './storage/readStateStore';
import { WorkGraph } from './services/workGraph';
import { ProviderRegistry } from './services/providerRegistry';
import { ActionRegistry } from './services/actionRegistry';
import { InboxTreeProvider } from './views/inboxTreeProvider';
import { QueueTreeProvider } from './views/queueTreeProvider';
import { FocusTreeProvider } from './views/focusTreeProvider';
import { SourcesTreeProvider } from './views/sourcesTreeProvider';
import { HistoryTreeProvider } from './views/historyTreeProvider';
import { registerCommands } from './commands/commands';
import { initLogger, setLogLevel, logger, resolveLogLevel } from './services/logger';
import { getInboxUnseenCount } from './services/inboxBadge';
import { getViewLayout, ViewId } from './views/viewLayout';
import { performance } from 'perf_hooks';

export type { WorkCenterApi, WorkCenterProvider, WorkCenterAction, DiscoveredItem, Disposable } from './api/types';
export { logger } from './services/logger';

/** Wrap an event callback so unhandled errors (sync or async) are logged instead of crashing. */
function safeHandler<T extends unknown[]>(label: string, fn: (...args: T) => void | Promise<void>): (...args: T) => void {
  return (...args: T) => {
    void Promise.resolve()
      .then(() => fn(...args))
      .catch((err: unknown) => {
        logger.error(label, err);
      });
  };
}

let providerRegistry: ProviderRegistry | undefined;
let actionRegistry: ActionRegistry | undefined;
let workGraph: WorkGraph | undefined;
let stateStore: DiscoveredStateStore | undefined;

function initializeLogging(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('WorkCenter');
  context.subscriptions.push(outputChannel);

  const logLevelConfig = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
  initLogger(outputChannel, resolveLogLevel(logLevelConfig));
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelConfig)) {
    logger.warn(`Invalid log level '${logLevelConfig}', falling back to 'info'. Valid values: debug, info, warn, error`);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(safeHandler('Error handling configuration change', (e) => {
      if (e.affectsConfiguration('workcenter.logLevel')) {
        const newLevel = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
        setLogLevel(resolveLogLevel(newLevel));
        if (!['debug', 'info', 'warn', 'error'].includes(newLevel)) {
          logger.warn(`Invalid log level '${newLevel}', falling back to 'info'. Valid values: debug, info, warn, error`);
        }
      }
    })),
  );
}

async function loadStores(storagePath: string): Promise<{ workGraph: WorkGraph; stateStore: DiscoveredStateStore; readStateStore: ReadStateStore }> {
  const store = new JsonTaskStore(storagePath);
  const wg = new WorkGraph(store);
  workGraph = wg;
  await wg.load();
  logger.debug(`Loaded ${wg.getAll().length} work items`);

  const ss = new DiscoveredStateStore(storagePath);
  stateStore = ss;
  await ss.load();
  logger.debug('Loaded discovered state');

  const readStateStore = new ReadStateStore(storagePath);
  await readStateStore.load();
  logger.debug('Loaded read state');

  return { workGraph: wg, stateStore: ss, readStateStore };
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
  readStateStore: ReadStateStore,
  workGraph: WorkGraph,
) {
  const inboxProvider = new InboxTreeProvider(providerRegistry, stateStore, readStateStore);
  const queueProvider = new QueueTreeProvider(workGraph, providerRegistry);
  const focusProvider = new FocusTreeProvider(workGraph, providerRegistry);
  const sourcesProvider = new SourcesTreeProvider(providerRegistry, stateStore);
  const historyProvider = new HistoryTreeProvider(workGraph, providerRegistry);

  // Apply persisted layout settings
  inboxProvider.layout = getViewLayout('inbox');
  queueProvider.layout = getViewLayout('queue');
  focusProvider.layout = getViewLayout('focus');
  sourcesProvider.layout = getViewLayout('sources');
  historyProvider.layout = getViewLayout('history');

  const inboxTreeView = vscode.window.createTreeView('workcenter.inbox', { treeDataProvider: inboxProvider, canSelectMany: true });
  const sourcesTreeView = vscode.window.createTreeView('workcenter.sources', { treeDataProvider: sourcesProvider, canSelectMany: true });
  const queueTreeView = vscode.window.createTreeView('workcenter.queue', { treeDataProvider: queueProvider, dragAndDropController: queueProvider, canSelectMany: true });
  const focusTreeView = vscode.window.createTreeView('workcenter.focus', { treeDataProvider: focusProvider, dragAndDropController: focusProvider, canSelectMany: true });
  const historyTreeView = vscode.window.createTreeView('workcenter.history', { treeDataProvider: historyProvider, canSelectMany: true });

  const inboxSelectionSub = inboxTreeView.onDidChangeSelection((e) => {
    void (async () => {
      const items = e.selection.filter(
        (item): item is { kind: 'item'; providerId: string; externalId: string } =>
          item.kind === 'item',
      );
      if (items.length === 0) { return; }
      const changed = await inboxProvider.markSeenBatch(items);
      if (changed) {
        inboxProvider.refresh();
      }
    })().catch(err => logger.error('Failed to mark inbox item as seen', err));
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

  const workGraphSub = workGraph.onDidChange(safeHandler('Error handling work graph change', updateWorkViewMessages));
  let initialLoadComplete = false;
  let wasLoading = false;

  const updateInboxBadge = () => {
    const count = getInboxUnseenCount(providerRegistry, stateStore, inboxProvider.sessionSeenItems);
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
      try {
        try {
          updateViewMessages();
        } catch (err: unknown) {
          logger.error('Error updating view messages', err);
        }
        try {
          updateInboxBadge();
        } catch (err: unknown) {
          logger.error('Error updating inbox badge', err);
        }
      } finally {
        uiUpdateScheduled = false;
      }
    });
  };

  // Set initial state
  updateWorkViewMessages();
  updateViewMessages();
  updateInboxBadge();

  const providerRegSub = providerRegistry.onDidRegisterProvider(safeHandler('Error handling provider registration', scheduleUiUpdate));
  const discoveredSub = providerRegistry.onDidChangeDiscoveredItems(safeHandler('Error handling discovered items change', () => {
    scheduleUiUpdate();

    // Mark initial load complete when loading transitions from true to false
    if (!initialLoadComplete) {
      if (wasLoading && !providerRegistry.loading) {
        initialLoadComplete = true;
      }
      wasLoading = wasLoading || providerRegistry.loading;
    }
  }));
  const newItemsSub = providerRegistry.onDidAddNewUnseenItems(safeHandler('Error handling new unseen items notification', (newCount) => {
    if (!initialLoadComplete) { return; }
    const config = vscode.workspace.getConfiguration('workcenter');
    const showNotifications = config.get<boolean>('showInboxNotifications', true);
    if (showNotifications && newCount > 0) {
      void vscode.window.showInformationMessage(
        `WorkCenter: ${newCount} new item${newCount === 1 ? '' : 's'} in Inbox`,
        'Show Inbox'
      ).then(
        action => {
          if (action === 'Show Inbox') {
            vscode.commands.executeCommand('workcenter.inbox.focus').then(
              undefined,
              () => { /* view focus is best-effort */ }
            );
          }
        },
        () => { /* notification is best-effort */ }
      );
    }
  }));
  const stateStoreSub = stateStore.onDidChange(safeHandler('Error handling state store change', scheduleUiUpdate));
  const markSeenSub = inboxProvider.onDidMarkSeen(safeHandler('Error handling mark seen', scheduleUiUpdate));

  return [discoveredSub, newItemsSub, providerRegSub, stateStoreSub, markSeenSub, workGraphSub];
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
  const activationStart = performance.now();
  initializeLogging(context);
  logger.info('WorkCenter activating...');

  const initStart = performance.now();
  const storagePath = context.globalStorageUri.fsPath;
  const { workGraph: wg, stateStore: ss, readStateStore } = await loadStores(storagePath);
  await migrateDiscoveredState(wg, ss);

  const pr = new ProviderRegistry(ss);
  providerRegistry = pr;
  const ar = new ActionRegistry();
  actionRegistry = ar;
  const api = new WorkCenterApiImpl(pr, ar);
  logger.info(`Store + service init took ${Math.round(performance.now() - initStart)}ms`);

  const treeViewStart = performance.now();
  const treeSetup = createTreeViews(pr, ss, readStateStore, wg);
  logger.info(`Tree view creation took ${Math.round(performance.now() - treeViewStart)}ms`);

  const eventWiringStart = performance.now();
  const eventDisposables = wireEvents(pr, ss, wg, treeSetup);
  logger.info(`Event wiring took ${Math.round(performance.now() - eventWiringStart)}ms`);

  const { providers, views, disposables: viewDisposables } = treeSetup;

  context.subscriptions.push(
    ...Object.values(views),
    ...viewDisposables,
    ...eventDisposables,
    { dispose: () => wg.dispose() },
    { dispose: () => ss.dispose() },
    { dispose: () => providers.inboxProvider.dispose() },
    { dispose: () => providers.queueProvider.dispose() },
    { dispose: () => providers.focusProvider.dispose() },
    { dispose: () => providers.sourcesProvider.dispose() },
    { dispose: () => providers.historyProvider.dispose() },
    { dispose: () => pr.dispose() },
    { dispose: () => ar.dispose() },
  );

  const commandRegStart = performance.now();
  registerCommands(context, wg, ar, ss, pr);
  logger.info(`Command registration took ${Math.round(performance.now() - commandRegStart)}ms`);

  // Register filter commands for each view
  const filterViews = [
    { name: 'Inbox', provider: providers.inboxProvider, key: 'inbox' },
    { name: 'Queue', provider: providers.queueProvider, key: 'queue' },
    { name: 'Focus', provider: providers.focusProvider, key: 'focus' },
    { name: 'History', provider: providers.historyProvider, key: 'history' },
    { name: 'Sources', provider: providers.sourcesProvider, key: 'sources' },
  ] as const;

  for (const { name, provider, key } of filterViews) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`workcenter.filter${name}`, async () => {
        const text = await vscode.window.showInputBox({
          prompt: `Filter ${name} items`,
          placeHolder: 'Type to filter…',
          value: provider.filterText,
        });
        if (text !== undefined) {
          provider.filterText = text;
          void vscode.commands.executeCommand('setContext', `workcenter.${key}FilterActive`, text.trim().length > 0);
        }
      }),
      vscode.commands.registerCommand(`workcenter.clear${name}Filter`, () => {
        provider.filterText = '';
        void vscode.commands.executeCommand('setContext', `workcenter.${key}FilterActive`, false);
      }),
    );
  }

  // Set context keys and listen for layout changes
  const viewIds: ViewId[] = ['inbox', 'queue', 'focus', 'history', 'sources'];
  const providerMap: Record<ViewId, { layout: import('./views/viewLayout').ViewLayout }> = {
    inbox: providers.inboxProvider,
    queue: providers.queueProvider,
    focus: providers.focusProvider,
    history: providers.historyProvider,
    sources: providers.sourcesProvider,
  };
  for (const id of viewIds) {
    void vscode.commands.executeCommand('setContext', `workcenter.${id}Layout`, getViewLayout(id));
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(safeHandler('Error handling viewLayout configuration change', (e) => {
      if (e.affectsConfiguration('workcenter.viewLayout')) {
        for (const id of viewIds) {
          const layout = getViewLayout(id);
          providerMap[id].layout = layout;
          void vscode.commands.executeCommand('setContext', `workcenter.${id}Layout`, layout);
        }
      }
    })),
  );

  logger.info(`WorkCenter activated in ${Math.round(performance.now() - activationStart)}ms`);
  return api;
}

/**
 * Deactivate the WorkCenter extension.
 *
 * All resources are disposed automatically via `context.subscriptions`,
 * so this function is intentionally a no-op.
 */
export function deactivate(): void {
  logger.info('WorkCenter deactivating...');
  providerRegistry?.dispose();
  actionRegistry?.dispose();
  workGraph?.dispose();
  stateStore?.dispose();
  logger.info('WorkCenter deactivated');
}
