import * as vscode from 'vscode';
import { DevDocketApi } from './api/types';
import { DevDocketApiImpl } from './api/devDocketApi';
import { JsonTaskStore } from './storage/jsonTaskStore';
import { DiscoveredStateStore } from './storage/discoveredStateStore';
import { ReadStateStore } from './storage/readStateStore';
import { ProviderLabelCache } from './storage/providerLabelCache';
import { WorkGraph } from './services/workGraph';
import { ProviderRegistry } from './services/providerRegistry';
import { checkAutoComplete, showAutoCompleteNotification } from './services/autoComplete';
import { ActionRegistry } from './services/actionRegistry';
import { WatcherRegistry } from './services/watcherRegistry';
import { WatcherService } from './services/watcherService';
import { WatchStore } from './storage/watchStore';
import { InboxTreeProvider } from './views/inboxTreeProvider';
import { QueueTreeProvider } from './views/queueTreeProvider';
import { FocusTreeProvider } from './views/focusTreeProvider';
import { SourcesTreeProvider } from './views/sourcesTreeProvider';
import { HistoryTreeProvider } from './views/historyTreeProvider';
import { WatchesTreeProvider } from './views/watchesTreeProvider';
import { WatchesStatusBar } from './views/watchesStatusBar';
import { registerCommands } from './commands/commands';
import { isSafeUrl } from './utils/url';
import { ViewRevealer } from './services/viewRevealer';
import { initLogger, setLogLevel, logger, resolveLogLevel } from './services/logger';
import { getInboxUnseenCount } from './services/inboxBadge';
import { syncProviderTitles } from './services/titleSync';
import { getViewLayout, ViewId } from './views/viewLayout';
import { performance } from 'perf_hooks';

export type { DevDocketApi, DevDocketProvider, DevDocketAction, DiscoveredItem, Disposable, ActivityLogEntry, ActivityType, StateTransitionEvent } from './api/types';
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


function initializeLogging(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('DevDocket');
  context.subscriptions.push(outputChannel);

  const logLevelConfig = vscode.workspace.getConfiguration('devdocket').get<string>('logLevel', 'info');
  initLogger(outputChannel, resolveLogLevel(logLevelConfig));
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelConfig)) {
    logger.warn(`Invalid log level '${logLevelConfig}', falling back to 'info'. Valid values: debug, info, warn, error`);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(safeHandler('Error handling configuration change', (e) => {
      if (e.affectsConfiguration('devdocket.logLevel')) {
        const newLevel = vscode.workspace.getConfiguration('devdocket').get<string>('logLevel', 'info');
        setLogLevel(resolveLogLevel(newLevel));
        if (!['debug', 'info', 'warn', 'error'].includes(newLevel)) {
          logger.warn(`Invalid log level '${newLevel}', falling back to 'info'. Valid values: debug, info, warn, error`);
        }
      }
    })),
  );
}

async function loadStores(storagePath: string): Promise<{ workGraph: WorkGraph; stateStore: DiscoveredStateStore; readStateStore: ReadStateStore; labelCache: ProviderLabelCache }> {
  const store = new JsonTaskStore(storagePath);
  const wg = new WorkGraph(store);
  await wg.load();
  logger.debug(`Loaded ${wg.getAll().length} work items`);

  const ss = new DiscoveredStateStore(storagePath);
  await ss.load();
  logger.debug('Loaded discovered state');

  const readStateStore = new ReadStateStore(storagePath);
  await readStateStore.load();
  logger.debug('Loaded read state');

  const labelCache = new ProviderLabelCache(storagePath);
  try {
    await labelCache.load();
    logger.debug('Loaded provider label cache');
  } catch (err) {
    logger.debug('Failed to load provider label cache; continuing with empty cache', err);
  }

  return { workGraph: wg, stateStore: ss, readStateStore, labelCache };
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
  watcherService: WatcherService,
) {
  const inboxProvider = new InboxTreeProvider(providerRegistry, stateStore, readStateStore);
  const queueProvider = new QueueTreeProvider(workGraph, providerRegistry);
  const focusProvider = new FocusTreeProvider(workGraph, providerRegistry);
  const sourcesProvider = new SourcesTreeProvider(providerRegistry, stateStore);
  const historyProvider = new HistoryTreeProvider(workGraph, providerRegistry);
  const watchesProvider = new WatchesTreeProvider(watcherService);

  // Apply persisted layout settings
  inboxProvider.layout = getViewLayout('inbox');
  queueProvider.layout = getViewLayout('queue');
  focusProvider.layout = getViewLayout('focus');
  sourcesProvider.layout = getViewLayout('sources');
  historyProvider.layout = getViewLayout('history');
  watchesProvider.layout = getViewLayout('watches');

  const inboxTreeView = vscode.window.createTreeView('devdocket.inbox', { treeDataProvider: inboxProvider, canSelectMany: true });
  const sourcesTreeView = vscode.window.createTreeView('devdocket.sources', { treeDataProvider: sourcesProvider, canSelectMany: true });
  const queueTreeView = vscode.window.createTreeView('devdocket.queue', { treeDataProvider: queueProvider, dragAndDropController: queueProvider, canSelectMany: true });
  const focusTreeView = vscode.window.createTreeView('devdocket.focus', { treeDataProvider: focusProvider, dragAndDropController: focusProvider, canSelectMany: true });
  const historyTreeView = vscode.window.createTreeView('devdocket.history', { treeDataProvider: historyProvider, canSelectMany: true });
  const watchesTreeView = vscode.window.createTreeView('devdocket.watches', { treeDataProvider: watchesProvider });

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
    providers: { inboxProvider, queueProvider, focusProvider, sourcesProvider, historyProvider, watchesProvider },
    views: { inboxTreeView, queueTreeView, focusTreeView, sourcesTreeView, historyTreeView, watchesTreeView },
    disposables: [inboxSelectionSub] as vscode.Disposable[],
  };
}

// Wires up all event-driven UI updates: view messages, inbox badge,
// coalesced provider events, new-item notifications, and watch notifications.
function wireEvents(
  providerRegistry: ProviderRegistry,
  stateStore: DiscoveredStateStore,
  workGraph: WorkGraph,
  watcherService: WatcherService,
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

    void syncProviderTitles(providerRegistry, workGraph).catch(err => {
      logger.error('Error syncing provider titles', err);
    });

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
    const config = vscode.workspace.getConfiguration('devdocket');
    const showNotifications = config.get<boolean>('showInboxNotifications', true);
    if (showNotifications && newCount > 0) {
      void vscode.window.showInformationMessage(
        `DevDocket: ${newCount} new item${newCount === 1 ? '' : 's'} in Inbox`,
        'Show Inbox'
      ).then(
        action => {
          if (action === 'Show Inbox') {
            vscode.commands.executeCommand('devdocket.inbox.focus').then(
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

  // Watch notifications
  const jobFailureSub = watcherService.onDidDetectJobFailure(safeHandler('Error handling job failure', ({ run, job }) => {
    const config = vscode.workspace.getConfiguration('devdocket.watches');
    const notifyOnJobFailure = config.get<boolean>('notifyOnJobFailure', true);
    if (!notifyOnJobFailure) {
      return;
    }
    
    // Count still-running jobs
    const runningCount = run.status.jobs.filter(j => j.state === 'running').length;
    const message = runningCount > 0
      ? `Job '${job.name}' failed in ${run.identifier.displayName} (${runningCount} job${runningCount === 1 ? '' : 's'} still running)`
      : `Job '${job.name}' failed in ${run.identifier.displayName}`;
    
    void vscode.window.showWarningMessage(message, 'View Run').then(action => {
      if (action === 'View Run') {
        const safe = isSafeUrl(run.identifier.url);
        if (safe) {
          void vscode.env.openExternal(vscode.Uri.parse(safe.href));
        }
      }
    });
  }));

  const runCompleteSub = watcherService.onDidCompleteRun(safeHandler('Error handling run completion', (run) => {
    const isSuccess = run.status.conclusion === 'success';
    const message = `${run.identifier.displayName} ${isSuccess ? 'succeeded' : run.status.conclusion || 'completed'}`;
    
    if (isSuccess) {
      void vscode.window.showInformationMessage(message, 'View Run').then(action => {
        if (action === 'View Run') {
          const safe = isSafeUrl(run.identifier.url);
          if (safe) {
            void vscode.env.openExternal(vscode.Uri.parse(safe.href));
          }
        }
      });
    } else {
      void vscode.window.showWarningMessage(message, 'View Run').then(action => {
        if (action === 'View Run') {
          const safe = isSafeUrl(run.identifier.url);
          if (safe) {
            void vscode.env.openExternal(vscode.Uri.parse(safe.href));
          }
        }
      });
    }
  }));

  // Auto-complete: after each provider refresh, scan all WorkGraph items with
  // that providerId and check whether their external items are closed/merged.
  // Per-provider guard prevents overlapping runs; AbortController cancels in-flight checks.
  const autoCompleteControllers = new Map<string, AbortController>();
  const autoCompleteSub = providerRegistry.onDidRefreshProvider(safeHandler('Error handling auto-complete', async (providerId) => {
    const config = vscode.workspace.getConfiguration('devdocket');
    if (!config.get<boolean>('autoCompleteOnClose', true)) {
      return;
    }
    // Abort any in-flight check for this provider
    const prev = autoCompleteControllers.get(providerId);
    if (prev) {
      prev.abort();
    }
    const controller = new AbortController();
    autoCompleteControllers.set(providerId, controller);
    try {
      const completedTitles = await checkAutoComplete(providerId, workGraph, providerRegistry, controller.signal);
      showAutoCompleteNotification(completedTitles);
    } finally {
      if (autoCompleteControllers.get(providerId) === controller) {
        autoCompleteControllers.delete(providerId);
      }
    }
  }));

  // Abort all in-flight auto-complete checks on disposal
  const autoCompleteCleanup = { dispose: () => {
    for (const controller of autoCompleteControllers.values()) {
      controller.abort();
    }
    autoCompleteControllers.clear();
  }};

  return [discoveredSub, newItemsSub, providerRegSub, stateStoreSub, markSeenSub, workGraphSub, jobFailureSub, runCompleteSub, autoCompleteSub, autoCompleteCleanup];
}

/**
 * Activate the DevDocket extension.
 *
 * Initialises storage, loads persisted work items and discovered-item state,
 * registers all tree views (Inbox, Queue, Focus, History, Sources), and
 * returns the public {@link DevDocketApi} for provider extensions to consume.
 *
 * @param context - The VS Code extension context provided at activation.
 * @returns The public API used by provider extensions to register providers and actions.
 */
export async function activate(context: vscode.ExtensionContext): Promise<DevDocketApi> {
  const activationStart = performance.now();
  initializeLogging(context);
  logger.info('DevDocket activating...');

  const initStart = performance.now();
  const storagePath = context.globalStorageUri.fsPath;
  const { workGraph: wg, stateStore: ss, readStateStore, labelCache } = await loadStores(storagePath);
  await migrateDiscoveredState(wg, ss);

  const pr = new ProviderRegistry(ss, labelCache);
  const ar = new ActionRegistry();
  const wr = new WatcherRegistry(logger);
  const watchStore = new WatchStore(storagePath);
  const ws = new WatcherService(wr, watchStore, logger);
  const api = new DevDocketApiImpl(pr, ar, wr, wg);
  logger.info(`Store + service init took ${Math.round(performance.now() - initStart)}ms`);

  const treeViewStart = performance.now();
  const treeSetup = createTreeViews(pr, ss, readStateStore, wg, ws);
  logger.info(`Tree view creation took ${Math.round(performance.now() - treeViewStart)}ms`);

  const eventWiringStart = performance.now();
  const eventDisposables = wireEvents(pr, ss, wg, ws, treeSetup);
  logger.info(`Event wiring took ${Math.round(performance.now() - eventWiringStart)}ms`);

  const { providers, views, disposables: viewDisposables } = treeSetup;

  // Create status bar item
  const watchesStatusBar = new WatchesStatusBar(ws);

  // Load persisted watches (must happen after tree views are registered to show restored watches)
  ws.loadPersistedWatches().catch(err => {
    logger.error('Failed to load persisted watches', err);
  });

  context.subscriptions.push(
    ...Object.values(views),
    ...viewDisposables,
    ...eventDisposables,
    watchesStatusBar,
    { dispose: () => wg.dispose() },
    { dispose: () => ss.dispose() },
    { dispose: () => ws.dispose() },
    { dispose: () => wr.dispose() },
    { dispose: () => providers.inboxProvider.dispose() },
    { dispose: () => providers.queueProvider.dispose() },
    { dispose: () => providers.focusProvider.dispose() },
    { dispose: () => providers.sourcesProvider.dispose() },
    { dispose: () => providers.historyProvider.dispose() },
    { dispose: () => providers.watchesProvider.dispose() },
    { dispose: () => pr.dispose() },
    { dispose: () => ar.dispose() },
  );

  const commandRegStart = performance.now();
  const revealer = new ViewRevealer(wg, views.queueTreeView, views.focusTreeView, views.historyTreeView);
  registerCommands(context, wg, ar, ss, pr, labelCache, wr, ws, revealer);
  logger.info(`Command registration took ${Math.round(performance.now() - commandRegStart)}ms`);

  // Set context keys and listen for layout changes
  const viewIds: ViewId[] = ['inbox', 'queue', 'focus', 'history', 'sources', 'watches'];
  const providerMap: Record<ViewId, { layout: import('./views/viewLayout').ViewLayout }> = {
    inbox: providers.inboxProvider,
    queue: providers.queueProvider,
    focus: providers.focusProvider,
    history: providers.historyProvider,
    sources: providers.sourcesProvider,
    watches: providers.watchesProvider,
  };
  for (const id of viewIds) {
    void vscode.commands.executeCommand('setContext', `devdocket.${id}Layout`, getViewLayout(id));
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(safeHandler('Error handling viewLayout configuration change', (e) => {
      if (e.affectsConfiguration('devdocket.viewLayout')) {
        for (const id of viewIds) {
          const layout = getViewLayout(id);
          providerMap[id].layout = layout;
          void vscode.commands.executeCommand('setContext', `devdocket.${id}Layout`, layout);
        }
      }
    })),
  );

  logger.info(`DevDocket activated in ${Math.round(performance.now() - activationStart)}ms`);
  return api;
}

/**
 * Deactivate the DevDocket extension.
 *
 * All resources are disposed automatically via `context.subscriptions`,
 * so this function is intentionally a no-op.
 */
export function deactivate(): void {
  // All resources are disposed automatically via context.subscriptions.
}
