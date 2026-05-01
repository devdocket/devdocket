import * as vscode from 'vscode';
import { DevDocketApi } from './api/types';
import { DevDocketApiImpl } from './api/devDocketApi';
import { JsonTaskStore } from './storage/jsonTaskStore';
import { DiscoveredStateStore } from './storage/discoveredStateStore';
import { ReadStateStore } from './storage/readStateStore';
import { ProviderLabelCache } from './storage/providerLabelCache';
import { migrateToGlobalState } from './storage/migration';
import { WorkGraph } from './services/workGraph';
import { ProviderRegistry } from './services/providerRegistry';
import { checkAutoComplete, showAutoCompleteNotification } from './services/autoComplete';
import { ActionRegistry } from './services/actionRegistry';
import { WatcherRegistry } from './services/watcherRegistry';
import { PRWatcherRegistry } from './services/prWatcherRegistry';
import { WatcherService } from './services/watcherService';
import { WatchStore } from './storage/watchStore';
import { WatchesStatusBar } from './views/watchesStatusBar';
import { ProviderHealthStatusBar } from './views/providerHealthStatusBar';
import { WatchPanelProvider } from './views/watchPanelProvider';
import { WorkItemEditorPanel, PanelManager } from './views/workItemEditorPanel';
import { MissionControlViewProvider } from './views/missionControlViewProvider';
import { registerCommands } from './commands/commands';
import { isSafeUrl } from './utils/url';
import { initLogger, setLogLevel, logger, resolveLogLevel } from './services/logger';
import { getInboxUnseenCount } from './services/inboxBadge';
import { syncProviderTitles } from './services/titleSync';
import { syncProviderDescriptions } from './services/descriptionSync';
import { performance } from 'perf_hooks';

export type { DevDocketApi, DevDocketProvider, DevDocketAction, DiscoveredItem, Disposable, ActivityLogEntry, ActivityType, StateTransitionEvent, DevDocketPRWatcher } from './api/types';
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

  const logLevelConfig = vscode.workspace.getConfiguration('devDocket').get<string>('logLevel', 'info');
  initLogger(outputChannel, resolveLogLevel(logLevelConfig));
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelConfig)) {
    logger.warn(`Invalid log level '${logLevelConfig}', falling back to 'info'. Valid values: debug, info, warn, error`);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(safeHandler('Error handling configuration change', (e) => {
      if (e.affectsConfiguration('devDocket.logLevel')) {
        const newLevel = vscode.workspace.getConfiguration('devDocket').get<string>('logLevel', 'info');
        setLogLevel(resolveLogLevel(newLevel));
        if (!['debug', 'info', 'warn', 'error'].includes(newLevel)) {
          logger.warn(`Invalid log level '${newLevel}', falling back to 'info'. Valid values: debug, info, warn, error`);
        }
      }
    })),
  );
}

async function loadStores(globalState: vscode.Memento): Promise<{ workGraph: WorkGraph; stateStore: DiscoveredStateStore; readStateStore: ReadStateStore; labelCache: ProviderLabelCache }> {
  const store = new JsonTaskStore(globalState);
  const wg = new WorkGraph(store);
  await wg.load();
  logger.debug(`Loaded ${wg.getAll().length} work items`);

  const ss = new DiscoveredStateStore(globalState);
  await ss.load();
  logger.debug('Loaded discovered state');

  const readStateStore = new ReadStateStore(globalState);
  await readStateStore.load();
  logger.debug('Loaded read state');

  const labelCache = new ProviderLabelCache(globalState);
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

function isAutoWatchCandidate(item: { authored?: boolean; url?: string }): item is { authored: true; url: string } {
  return item.authored === true && typeof item.url === 'string';
}

export async function autoWatchAuthoredPRs(
  providerId: string,
  providerRegistry: ProviderRegistry,
  prWatcherRegistry: PRWatcherRegistry,
  watcherService: WatcherService,
  signal: AbortSignal,
): Promise<void> {
  const items = providerRegistry.getDiscoveredItems(providerId).filter(isAutoWatchCandidate);

  for (const item of items) {
    if (signal.aborted) {
      return;
    }

    try {
      const itemUrl = item.url;
      if (!itemUrl) {
        continue;
      }

      const prWatcher = prWatcherRegistry.findWatcherForUrl(itemUrl);
      if (!prWatcher) {
        continue;
      }

      const identifier = prWatcher.parsePRUrl(itemUrl);
      if (await watcherService.isPRWatched(identifier)) {
        continue;
      }

      await watcherService.startPRWatch(identifier);
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      logger.warn(`Failed to auto-watch authored PR from provider ${providerId}`, { url: item.url }, err);
    }
  }
}

function wireEvents(
  providerRegistry: ProviderRegistry,
  workGraph: WorkGraph,
  watcherService: WatcherService,
  prWatcherRegistry: PRWatcherRegistry,
): vscode.Disposable[] {
  let initialLoadComplete = false;
  let wasLoading = false;

  const discoveredSub = providerRegistry.onDidChangeDiscoveredItems(safeHandler('Error handling discovered items change', () => {
    if (!initialLoadComplete) {
      if (wasLoading && !providerRegistry.loading) {
        initialLoadComplete = true;
      }
      wasLoading = wasLoading || providerRegistry.loading;
    }
  }));

  const newItemsSub = providerRegistry.onDidAddNewUnseenItems(safeHandler('Error handling new unseen items notification', (newCount) => {
    if (!initialLoadComplete) { return; }
    const config = vscode.workspace.getConfiguration('devDocket');
    const showNotifications = config.get<boolean>('showInboxNotifications', true);
    if (showNotifications && newCount > 0) {
      void vscode.window.showInformationMessage(
        `DevDocket: ${newCount} new item${newCount === 1 ? '' : 's'} in Incoming`,
        'Open Mission Control',
      ).then(
        action => {
          if (action === 'Open Mission Control') {
            vscode.commands.executeCommand('devdocket.missionControl.focus').then(
              undefined,
              () => { /* view focus is best-effort */ },
            );
          }
        },
        () => { /* notification is best-effort */ },
      );
    }
  }));

  const jobFailureSub = watcherService.onDidDetectJobFailure(safeHandler('Error handling job failure', ({ run, job }) => {
    const config = vscode.workspace.getConfiguration('devDocket.watches');
    const notifyOnJobFailure = config.get<boolean>('notifyOnJobFailure', true);
    if (!notifyOnJobFailure) {
      return;
    }

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

  const autoWatchControllers = new Map<string, AbortController>();
  const autoCompleteControllers = new Map<string, AbortController>();
  const autoCompleteSub = providerRegistry.onDidRefreshProvider(safeHandler('Error handling provider refresh', async (providerId) => {
    try {
      await syncProviderTitles(providerId, providerRegistry, workGraph);
    } catch (err) {
      logger.error('Error syncing provider titles', err);
    }

    try {
      await syncProviderDescriptions(providerId, providerRegistry, workGraph);
    } catch (err) {
      logger.error('Error syncing provider descriptions', err);
    }

    const refreshTasks: Promise<void>[] = [];

    const watchConfig = vscode.workspace.getConfiguration('devDocket.watches');
    if (watchConfig.get<boolean>('autoWatchAuthoredPRs', true)) {
      const prevAutoWatch = autoWatchControllers.get(providerId);
      if (prevAutoWatch) {
        prevAutoWatch.abort();
      }
      const autoWatchController = new AbortController();
      autoWatchControllers.set(providerId, autoWatchController);
      refreshTasks.push((async () => {
        try {
          await autoWatchAuthoredPRs(providerId, providerRegistry, prWatcherRegistry, watcherService, autoWatchController.signal);
        } finally {
          if (autoWatchControllers.get(providerId) === autoWatchController) {
            autoWatchControllers.delete(providerId);
          }
        }
      })());
    }

    const config = vscode.workspace.getConfiguration('devDocket');
    if (config.get<boolean>('autoCompleteOnClose', true)) {
      const prev = autoCompleteControllers.get(providerId);
      if (prev) {
        prev.abort();
      }
      const controller = new AbortController();
      autoCompleteControllers.set(providerId, controller);
      refreshTasks.push((async () => {
        try {
          const completedTitles = await checkAutoComplete(providerId, workGraph, providerRegistry, controller.signal);
          showAutoCompleteNotification(completedTitles);
        } finally {
          if (autoCompleteControllers.get(providerId) === controller) {
            autoCompleteControllers.delete(providerId);
          }
        }
      })());
    }

    const results = await Promise.allSettled(refreshTasks);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error(`Error running provider refresh follow-up for ${providerId}`, result.reason);
      }
    }
  }));

  const autoWatchCleanup = { dispose: () => {
    for (const controller of autoWatchControllers.values()) {
      controller.abort();
    }
    autoWatchControllers.clear();
  }};
  const autoCompleteCleanup = { dispose: () => {
    for (const controller of autoCompleteControllers.values()) {
      controller.abort();
    }
    autoCompleteControllers.clear();
  }};

  return [
    discoveredSub,
    newItemsSub,
    jobFailureSub,
    runCompleteSub,
    autoCompleteSub,
    autoWatchCleanup,
    autoCompleteCleanup,
  ];
}

/**
 * Activate the DevDocket extension.
 *
 * Initialises storage, loads persisted work items and discovered-item state,
 * registers the Mission Control webview, status bars, and watch panel, and
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
  await migrateToGlobalState(context.globalState, storagePath);
  const { workGraph: wg, stateStore: ss, readStateStore, labelCache } = await loadStores(context.globalState);
  await migrateDiscoveredState(wg, ss);

  const pr = new ProviderRegistry(
    ss, labelCache,
    (providerId, externalId) => wg.findItemByProvenance(providerId, externalId)?.state,
    async (providerId, externalId, type, detail) => {
      const item = wg.findItemByProvenance(providerId, externalId);
      if (item) { await wg.addActivity(item.id, type, detail); }
    },
  );
  const ar = new ActionRegistry();
  const wr = new WatcherRegistry(logger);
  const pwr = new PRWatcherRegistry(logger);
  const watchStore = new WatchStore(context.globalState);
  const ws = new WatcherService(wr, pwr, watchStore, logger);
  const api = new DevDocketApiImpl(pr, ar, wr, pwr, wg);
  logger.info(`Store + service init took ${Math.round(performance.now() - initStart)}ms`);

  const watchPanelProvider = new WatchPanelProvider(context.extensionUri, ws);

  const eventWiringStart = performance.now();
  const eventDisposables = wireEvents(pr, wg, ws, pwr);
  logger.info(`Event wiring took ${Math.round(performance.now() - eventWiringStart)}ms`);

  // Create status bar items
  const watchesStatusBar = new WatchesStatusBar(ws);
  const incomingStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  incomingStatusBar.command = 'devdocket.missionControl.focus';
  const updateIncomingStatusBar = () => {
    const count = getInboxUnseenCount(pr, ss);
    if (count > 0) {
      incomingStatusBar.text = `⚡ ${count} incoming`;
      incomingStatusBar.tooltip = `Open Mission Control (${count} incoming item${count === 1 ? '' : 's'})`;
      incomingStatusBar.show();
      return;
    }
    incomingStatusBar.hide();
  };
  updateIncomingStatusBar();

  const providerHealthStatusBar = new ProviderHealthStatusBar(pr);

  const missionControlProvider = new MissionControlViewProvider(
    context.extensionUri,
    wg,
    pr,
    ss,
    readStateStore,
    ws,
    ar,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      MissionControlViewProvider.viewId,
      missionControlProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    wg.onDidChange(safeHandler('mc:workGraph', () => missionControlProvider.scheduleRefresh())),
    pr.onDidChangeDiscoveredItems(safeHandler('mc:discovered', () => missionControlProvider.scheduleRefresh())),
    pr.onDidChangeProviderHealth(safeHandler('mc:health', () => missionControlProvider.scheduleRefresh())),
    ss.onDidChange(safeHandler('mc:stateStore', () => missionControlProvider.scheduleRefresh())),
    ws.onDidChangeWatchedRuns(safeHandler('mc:watchedRuns', () => missionControlProvider.scheduleRefresh())),
    ws.onDidChangePRWatches(safeHandler('mc:watchedPRs', () => missionControlProvider.scheduleRefresh())),
    pr.onDidChangeDiscoveredItems(safeHandler('incoming:discovered', updateIncomingStatusBar)),
    ss.onDidChange(safeHandler('incoming:stateStore', updateIncomingStatusBar)),
    ws.onDidChangeWatchedRuns(safeHandler('watch-panel:runs', () => watchPanelProvider.refresh())),
    ws.onDidChangePRWatches(safeHandler('watch-panel:prs', () => watchPanelProvider.refresh())),
  );

  // Load persisted watches after the watch services are ready.
  ws.loadPersistedWatches().catch(err => {
    logger.error('Failed to load persisted watches', err);
  });

  // Scope panel cache to extension lifecycle
  const panelManager = new PanelManager();
  WorkItemEditorPanel.setPanelManager(panelManager);
  WorkItemEditorPanel.setDependencies(ar, ss);

  // panelManager must be first: its dispose() flushes pending saves via
  // WorkGraph, which must still be alive at that point. VS Code disposes
  // subscriptions in array order, so placing it first ensures it runs
  // before WorkGraph is disposed.
  context.subscriptions.push(
    panelManager,
    ...eventDisposables,
    watchPanelProvider,
    watchesStatusBar,
    incomingStatusBar,
    providerHealthStatusBar,
    { dispose: () => wg.dispose() },
    { dispose: () => ss.dispose() },
    { dispose: () => ws.dispose() },
    { dispose: () => wr.dispose() },
    { dispose: () => pwr.dispose() },
    { dispose: () => pr.dispose() },
    { dispose: () => ar.dispose() },
  );

  const commandRegStart = performance.now();
  registerCommands(context, wg, ar, ss, pr, labelCache, wr, pwr, ws, watchPanelProvider);
  logger.info(`Command registration took ${Math.round(performance.now() - commandRegStart)}ms`);

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
