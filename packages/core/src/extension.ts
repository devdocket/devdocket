import * as vscode from 'vscode';
import { runWorkerPool, type PRIdentifier } from '@devdocket/shared';
import { DevDocketApi } from './api/types';
import { DevDocketApiImpl } from './api/devDocketApi';
import { JsonTaskStore } from './storage/jsonTaskStore';
import { InboxStateStore } from './storage/inboxStateStore';
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
import { WorkItemEditorPanel, PanelManager, type WorkItemEditorPanelDependencies } from './views/workItemEditorPanel';
import { IncomingPreviewPanel, IncomingPreviewPanelManager } from './views/incomingPreviewPanel';
import { MainViewProvider } from './views/mainViewProvider';
import { registerCommands } from './commands/commands';
import { isSafeUrl } from './utils/url';
import { logger, setLogger } from './services/logger';
import { syncProviderTitles } from './services/titleSync';
import { syncProviderDescriptions } from './services/descriptionSync';
import { performance } from 'perf_hooks';

export type { DevDocketApi, DevDocketProvider, DevDocketAction, ProviderItem, Disposable, ActivityLogEntry, ActivityType, StateTransitionEvent, DevDocketPRWatcher } from './api/types';
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


function initializeLogging(context: vscode.ExtensionContext): vscode.LogOutputChannel {
  const log = vscode.window.createOutputChannel('DevDocket', { log: true });
  context.subscriptions.push(log);
  setLogger(log);
  return log;
}

async function loadStores(globalState: vscode.Memento): Promise<{ workGraph: WorkGraph; stateStore: InboxStateStore; readStateStore: ReadStateStore; labelCache: ProviderLabelCache }> {
  const store = new JsonTaskStore(globalState);
  const wg = new WorkGraph(store);
  await wg.load();
  logger.debug(`Loaded ${wg.getAll().length} work items`);

  const ss = new InboxStateStore(globalState);
  await ss.load();
  logger.debug('Loaded inbox state');

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

async function migrateInboxState(workGraph: WorkGraph, stateStore: InboxStateStore): Promise<void> {
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

/**
 * Maximum number of authored PRs from a single provider that we'll auto-watch
 * in one refresh pass. Prevents a buggy or hostile provider from creating an
 * unbounded number of polling timers (each watch costs a network round-trip
 * per poll interval).
 */
const MAX_AUTO_WATCH_PER_PROVIDER = 200;
const AUTO_WATCH_CONCURRENCY = 6;
const AUTO_WATCH_YIELD_EVERY = 25;
const autoWatchCapNotifiedProviders = new Set<string>();

/**
 * Strip query string and fragment from a URL before logging so that
 * provider-controlled values (which may include API tokens deliberately
 * planted to be exfiltrated through log capture) don't end up persisted in
 * the Output channel verbatim. Keeps origin + path so the log still names
 * which item failed.
 */
function redactUrlForLog(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<unparseable>';
  }
}

function getAutoWatchPRKey(identifier: PRIdentifier): string {
  return `${identifier.providerId}:${identifier.repo}:${identifier.prId}`;
}

async function yieldToExtensionHost(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
      return;
    }
    setTimeout(resolve, 0);
  });
}

interface AutoWatchAuthoredPROptions {
  capNotifiedProviders?: Set<string>;
  seenPRKeys?: Set<string>;
}

export async function autoWatchAuthoredPRs(
  providerId: string,
  providerRegistry: ProviderRegistry,
  prWatcherRegistry: PRWatcherRegistry,
  watcherService: WatcherService,
  signal: AbortSignal,
  options: AutoWatchAuthoredPROptions = {},
): Promise<void> {
  const capNotifiedProviders = options.capNotifiedProviders ?? autoWatchCapNotifiedProviders;
  const sharedSeenPRKeys = options.seenPRKeys;
  const items = providerRegistry.getProviderItems(providerId).filter(isAutoWatchCandidate);
  const localSeenPRKeys = new Set<string>();
  const reservedPRKeys = new Set<string>();
  const candidates: Array<{ identifier: PRIdentifier; sourceUrl: string }> = [];
  let skippedCount = 0;

  try {
    for (const item of items) {
      if (signal.aborted) {
        return;
      }

      try {
        const itemUrl = item.url;
        if (!itemUrl) {
          continue;
        }

        // Defense-in-depth: only http(s) URLs are safe to feed into PR
        // watcher resolution. A malicious provider can claim authored:true
        // for arbitrary strings; reject anything that wouldn't survive
        // isSafeUrl downstream.
        if (!isSafeUrl(itemUrl)) {
          continue;
        }

        const prWatcher = prWatcherRegistry.findWatcherForUrl(itemUrl);
        if (!prWatcher) {
          continue;
        }

        const identifier = prWatcher.parsePRUrl(itemUrl);
        const prKey = getAutoWatchPRKey(identifier);
        if (localSeenPRKeys.has(prKey) || sharedSeenPRKeys?.has(prKey)) {
          continue;
        }
        localSeenPRKeys.add(prKey);

        if (await watcherService.isPRWatched(identifier)) {
          continue;
        }

        if (sharedSeenPRKeys?.has(prKey)) {
          continue;
        }

        if (candidates.length >= MAX_AUTO_WATCH_PER_PROVIDER) {
          skippedCount++;
          continue;
        }

        sharedSeenPRKeys?.add(prKey);
        reservedPRKeys.add(prKey);
        candidates.push({ identifier, sourceUrl: itemUrl });
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        logger.warn(`Failed to auto-watch authored PR from provider ${providerId}`, { url: redactUrlForLog(item.url) }, err);
      }
    }

    const candidatesToWatch = candidates;
    if (skippedCount > 0) {
      const message = `DevDocket: Auto-watching the first ${MAX_AUTO_WATCH_PER_PROVIDER} authored PRs from ${providerId}; skipping ${skippedCount} more to keep refresh responsive.`;
      logger.warn(
        `Auto-watch cap reached for provider ${providerId} (limit ${MAX_AUTO_WATCH_PER_PROVIDER}); skipping ${skippedCount} authored PRs to bound polling cost`,
      );
      if (!capNotifiedProviders.has(providerId)) {
        capNotifiedProviders.add(providerId);
        void vscode.window.showInformationMessage(message).then(
          undefined,
          () => { /* notification is best-effort */ },
        );
      }
    }

    let completedCount = 0;
    await runWorkerPool(candidatesToWatch, async ({ identifier, sourceUrl }) => {
      if (signal.aborted) {
        return;
      }

      try {
        await watcherService.startPRWatch(identifier, { deferChildRunStatus: true });
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        logger.warn(`Failed to auto-watch authored PR from provider ${providerId}`, { url: redactUrlForLog(sourceUrl) }, err);
      } finally {
        completedCount++;
        if (completedCount % AUTO_WATCH_YIELD_EVERY === 0) {
          await yieldToExtensionHost();
        }
      }
    }, AUTO_WATCH_CONCURRENCY);
  } finally {
    for (const prKey of reservedPRKeys) {
      sharedSeenPRKeys?.delete(prKey);
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

  const discoveredSub = providerRegistry.onDidChangeProviderItems(safeHandler('Error handling discovered items change', () => {
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
        'Open DevDocket',
      ).then(
        action => {
          if (action === 'Open DevDocket') {
            vscode.commands.executeCommand('devdocket.main.focus').then(
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
    const isPartialSuccess = run.status.conclusion === 'partial_success';
    const message = `${run.identifier.displayName} ${toRunCompletionLabel(run.status.conclusion)}`;

    if (isSuccess || isPartialSuccess) {
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
  const autoWatchSeenPRKeys = new Set<string>();
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
          await autoWatchAuthoredPRs(providerId, providerRegistry, prWatcherRegistry, watcherService, autoWatchController.signal, { seenPRKeys: autoWatchSeenPRKeys });
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

function toRunCompletionLabel(conclusion?: string): string {
  if (!conclusion) {
    return 'completed';
  }
  if (conclusion === 'success') {
    return 'succeeded';
  }
  if (conclusion === 'partial_success') {
    return 'succeeded with issues';
  }
  if (conclusion === 'failure') {
    return 'failed';
  }
  const label = conclusion.replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Activate the DevDocket extension.
 *
 * Initialises storage, loads persisted work items and discovered-item state,
 * registers the DevDocket webview, status bars, and watch panel, and
 * returns the public {@link DevDocketApi} for provider extensions to consume.
 *
 * @param context - The VS Code extension context provided at activation.
 * @returns The public API used by provider extensions to register providers and actions.
 */
export async function activate(context: vscode.ExtensionContext): Promise<DevDocketApi> {
  const activationStart = performance.now();
  const log = initializeLogging(context);
  log.info('DevDocket activating...');

  const initStart = performance.now();
  const storagePath = context.globalStorageUri.fsPath;
  await migrateToGlobalState(context.globalState, storagePath);
  const { workGraph: wg, stateStore: ss, readStateStore, labelCache } = await loadStores(context.globalState);
  await migrateInboxState(wg, ss);

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

  const watchPanelProvider = new WatchPanelProvider(context.extensionUri, ws, wg, pr);

  const eventWiringStart = performance.now();
  const eventDisposables = wireEvents(pr, wg, ws, pwr);
  logger.info(`Event wiring took ${Math.round(performance.now() - eventWiringStart)}ms`);

  // Create status bar items
  const watchesStatusBar = new WatchesStatusBar(ws);

  const providerHealthStatusBar = new ProviderHealthStatusBar(pr);

  const mainProvider = new MainViewProvider(
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
      MainViewProvider.viewId,
      mainProvider,
    ),
    wg.onDidChange(safeHandler('mc:workGraph', () => mainProvider.scheduleRefresh('workGraph'))),
    pr.onDidChangeProviderItems(safeHandler('mc:discovered', () => mainProvider.scheduleRefresh('discovered'))),
    pr.onDidChangeProviderHealth(safeHandler('mc:health', () => mainProvider.scheduleRefresh('health'))),
    ss.onDidChange(safeHandler('mc:stateStore', () => mainProvider.scheduleRefresh('state'))),
    ws.onDidChangeWatchedRuns(safeHandler('mc:watchedRuns', () => mainProvider.scheduleRefresh('watchedRuns'))),
    ws.onDidChangePRWatches(safeHandler('mc:watchedPRs', () => mainProvider.scheduleRefresh('watchedPRs'))),
    readStateStore.onDidChange(safeHandler('mc:readState', () => mainProvider.scheduleRefresh('readState'))),
    pr.onDidRefreshProvider(safeHandler('mc:prune', async (providerId) => {
      if (pr.wasLastRefreshTruncated(providerId)) {
        logger.debug(`Skipping prune for provider ${providerId} because the latest refresh was truncated`);
        return;
      }

      const active = new Map([[providerId, pr.getProviderItems(providerId)]]);
      try {
        const ssPruned = await ss.prune(active);
        const rsPruned = await readStateStore.prune(active);
        if (ssPruned > 0 || rsPruned > 0) {
          logger.debug(`Pruned ${ssPruned} inbox-state and ${rsPruned} read-state records for provider ${providerId}`);
        }
      } catch (err) {
        logger.error('DevDocket: prune failed', err);
      }
    })),
    ws.onDidChangeWatchedRuns(safeHandler('watch-panel:runs', () => watchPanelProvider.refresh())),
    ws.onDidChangePRWatches(safeHandler('watch-panel:prs', () => watchPanelProvider.refresh())),
  );

  // Load persisted watches after watch-service subscriptions are ready but before
  // commands and the public API can start new watches.
  try {
    await ws.loadPersistedWatches();
  } catch (err) {
    logger.error('Failed to load persisted watches', err);
  }

  // Scope panel caches to extension lifecycle.
  const panelManager = new PanelManager();
  const incomingPreviewPanelManager = new IncomingPreviewPanelManager();
  const editorPanelDependencies: WorkItemEditorPanelDependencies = {
    panelManager,
    actionRegistry: ar,
    stateStore: ss,
    watcherService: ws,
  };

  // Panel managers must be first: editor disposal flushes pending saves via
  // WorkGraph, which must still be alive at that point. VS Code disposes
  // subscriptions in array order, so placing them first ensures they run
  // before WorkGraph is disposed.
  context.subscriptions.push(
    panelManager,
    incomingPreviewPanelManager,
    vscode.window.registerWebviewPanelSerializer(
      WorkItemEditorPanel.viewType,
      WorkItemEditorPanel.createSerializer(context, wg, pr, editorPanelDependencies),
    ),
    vscode.window.registerWebviewPanelSerializer(
      IncomingPreviewPanel.viewType,
      IncomingPreviewPanel.createSerializer(context, incomingPreviewPanelManager, pr, ss, readStateStore, wg),
    ),
    vscode.window.registerWebviewPanelSerializer(
      WatchPanelProvider.viewType,
      watchPanelProvider.createSerializer(),
    ),
    ...eventDisposables,
    mainProvider,
    watchPanelProvider,
    watchesStatusBar,
    providerHealthStatusBar,
    { dispose: () => wg.dispose() },
    { dispose: () => ss.dispose() },
    { dispose: () => readStateStore.dispose() },
    { dispose: () => ws.dispose() },
    { dispose: () => wr.dispose() },
    { dispose: () => pwr.dispose() },
    { dispose: () => pr.dispose() },
    { dispose: () => ar.dispose() },
  );

  const commandRegStart = performance.now();
  registerCommands(context, wg, ar, ss, readStateStore, pr, labelCache, wr, pwr, ws, watchPanelProvider, editorPanelDependencies, incomingPreviewPanelManager, () => mainProvider.toggleSearch());
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
