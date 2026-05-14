import * as vscode from 'vscode';
import { WatcherService, type WatchedRun, type WatchedPR } from '../services/watcherService';
import { WatcherRegistry } from '../services/watcherRegistry';
import { PRWatcherRegistry } from '../services/prWatcherRegistry';
import type { WatchPanelProvider } from '../views/watchPanelProvider';
import { isSafeUrl } from '../utils/url';
import { wrapCommand, handleCommandError } from './commandUtils';
import { classifyWatchUrl, WATCH_URL_PLACEHOLDER, type WatchUrlClassification } from './watchUrlClassifier';

async function handleWatchUrl(
  watcherRegistry: WatcherRegistry,
  prWatcherRegistry: PRWatcherRegistry,
  watcherService: WatcherService,
): Promise<void> {
  const url = await vscode.window.showInputBox({
    prompt: 'Paste a GitHub or Azure DevOps pull request or pipeline run URL',
    placeHolder: WATCH_URL_PLACEHOLDER,
    validateInput: (value) => formatWatchUrlValidation(classifyWatchUrl(value, watcherRegistry, prWatcherRegistry)),
  });

  if (!url?.trim()) {
    return;
  }

  const classification = classifyWatchUrl(url, watcherRegistry, prWatcherRegistry);
  if (!classification.ok) {
    void vscode.window.showErrorMessage(`DevDocket: ${classification.message}`);
    return;
  }

  try {
    if (classification.kind === 'pr') {
      const identifier = classification.watcher.parsePRUrl(classification.url);
      const wasActive = watcherService.isPRActive(identifier);
      const watch = await watcherService.startPRWatch(identifier, { forceRecreate: true });
      const message = wasActive
        ? `Re-watching PR: ${watch.identifier.displayName}`
        : `Now watching PR: ${watch.identifier.displayName}`;
      void vscode.window.showInformationMessage(message);
      return;
    }

    const identifier = classification.watcher.parseRunUrl(classification.url);
    const wasActive = watcherService.isRunActive(identifier);
    const watch = await watcherService.startWatch(identifier);
    const message = wasActive
      ? `Already watching run: ${watch.identifier.displayName}`
      : `Now watching run: ${watch.identifier.displayName}`;
    void vscode.window.showInformationMessage(message);
  } catch (err: unknown) {
    handleCommandError(
      classification.kind === 'pr' ? 'Failed to watch PR' : 'Failed to watch pipeline run',
      err,
    );
  }
}

function formatWatchUrlValidation(classification: WatchUrlClassification): string | vscode.InputBoxValidationMessage | undefined {
  if (!classification.ok) {
    return classification.reason === 'empty' ? undefined : classification.message;
  }
  return {
    message: classification.validationMessage,
    severity: vscode.InputBoxValidationSeverity.Info,
  };
}

// Normalize argument: context menu passes WatchedRunNode, inline click passes WatchedRun
function resolveWatchedRun(arg: unknown): WatchedRun | undefined {
  if (!arg || typeof arg !== 'object') {
    return undefined;
  }
  if ('watchedRun' in arg) {
    return (arg as { watchedRun: WatchedRun }).watchedRun;
  }
  if ('identifier' in arg && 'status' in arg) {
    return arg as WatchedRun;
  }
  return undefined;
}

// Normalize argument: context menu passes WatchedPRNode, inline click passes WatchedPR
function resolveWatchedPR(arg: unknown): WatchedPR | undefined {
  if (!arg || typeof arg !== 'object') {
    return undefined;
  }
  if ('watchedPR' in arg) {
    return (arg as { watchedPR: WatchedPR }).watchedPR;
  }
  if ('identifier' in arg && 'prState' in arg) {
    return arg as WatchedPR;
  }
  return undefined;
}

async function handleWatchPRFromItem(
  watcherRegistry: WatcherRegistry,
  prWatcherRegistry: PRWatcherRegistry,
  watcherService: WatcherService,
  arg: unknown,
): Promise<void> {
  const url = extractItemUrl(arg);
  if (!url) {
    void vscode.window.showWarningMessage('DevDocket: Select an item with a URL to watch its CI.');
    return;
  }

  const safeUrl = isSafeUrl(url);
  if (!safeUrl) {
    void vscode.window.showWarningMessage('DevDocket: Only http(s) URLs are supported.');
    return;
  }

  // Try PR watchers first, then run watchers
  const prWatcher = prWatcherRegistry.findWatcherForUrl(safeUrl.href);
  if (prWatcher) {
    const identifier = prWatcher.parsePRUrl(safeUrl.href);
    const wasActive = watcherService.isPRActive(identifier);
    // Pass forceRecreate so this acts as an "explicit user intent" entry
    // point (matching the manual Watch URL command). Without it, a PR
    // that ended up invisible after all its child runs were dismissed
    // would silently re-return the broken watch unchanged.
    const watch = await watcherService.startPRWatch(identifier, { forceRecreate: true });
    const message = wasActive
      ? `Re-watching PR: ${watch.identifier.displayName}`
      : `Now watching PR: ${watch.identifier.displayName}`;
    void vscode.window.showInformationMessage(message);
    return;
  }

  const runWatcher = watcherRegistry.findWatcherForUrl(safeUrl.href);
  if (runWatcher) {
    const identifier = runWatcher.parseRunUrl(safeUrl.href);
    const wasActive = watcherService.isRunActive(identifier);
    const watch = await watcherService.startWatch(identifier);
    const message = wasActive
      ? `Already watching run: ${watch.identifier.displayName}`
      : `Now watching run: ${watch.identifier.displayName}`;
    void vscode.window.showInformationMessage(message);
    return;
  }

  void vscode.window.showWarningMessage('DevDocket: No registered watcher recognizes this item\'s URL.');
}

function extractItemUrl(arg: unknown): string | undefined {
  if (!arg || typeof arg !== 'object') {
    return undefined;
  }
  if ('url' in arg && typeof (arg as { url: unknown }).url === 'string') {
    return (arg as { url: string }).url;
  }
  return undefined;
}

async function handleDismissWatch(arg: unknown, watcherService: WatcherService): Promise<void> {
  try {
    // Try PR first
    const watchedPR = resolveWatchedPR(arg);
    if (watchedPR) {
      watcherService.dismissPRWatch(watchedPR.identifier);
      return;
    }
    const watchedRun = resolveWatchedRun(arg);
    if (!watchedRun) {
      void vscode.window.showInformationMessage('Select a watch from the Watches view to dismiss.');
      return;
    }
    watcherService.dismissWatch(watchedRun.identifier);
  } catch (err: unknown) {
    handleCommandError('Failed to dismiss watch', err);
  }
}

async function handleDismissAllCompletedWatches(watcherService: WatcherService): Promise<void> {
  try {
    const count = watcherService.countCompletedActiveWatches();
    if (count === 0) {
      void vscode.window.showInformationMessage('No completed watches to dismiss.');
      return;
    }
    const noun = count === 1 ? 'watch' : 'watches';
    const confirm = await vscode.window.showWarningMessage(
      `Dismiss ${count} completed ${noun}? They will be removed from the Watches view.`,
      { modal: true },
      'Dismiss',
    );
    if (confirm !== 'Dismiss') {
      return;
    }
    watcherService.dismissAllCompleted();
  } catch (err: unknown) {
    handleCommandError('Failed to dismiss all completed watches', err);
  }
}

async function handleOpenWatchUrl(arg: unknown): Promise<void> {
  try {
    // Try PR first
    const watchedPR = resolveWatchedPR(arg);
    if (watchedPR) {
      const safeUrl = isSafeUrl(watchedPR.identifier.url);
      if (!safeUrl) {
        void vscode.window.showWarningMessage('Can only open http(s) URLs in the browser.');
        return;
      }
      const opened = await vscode.env.openExternal(vscode.Uri.parse(safeUrl.href));
      if (!opened) {
        void vscode.window.showWarningMessage('Failed to open URL in the browser.');
      }
      return;
    }

    const watchedRun = resolveWatchedRun(arg);
    if (!watchedRun) {
      void vscode.window.showInformationMessage('Select a watch from the Watches view to open.');
      return;
    }
    const safeUrl = isSafeUrl(watchedRun.identifier.url);
    if (!safeUrl) {
      void vscode.window.showWarningMessage('Can only open http(s) URLs in the browser.');
      return;
    }
    const opened = await vscode.env.openExternal(vscode.Uri.parse(safeUrl.href));
    if (!opened) {
      void vscode.window.showWarningMessage('Failed to open URL in the browser.');
    }
  } catch (err: unknown) {
    handleCommandError('Failed to open URL', err);
  }
}

export function registerWatchCommands(
  context: vscode.ExtensionContext,
  watcherRegistry: WatcherRegistry,
  prWatcherRegistry: PRWatcherRegistry,
  watcherService: WatcherService,
  watchPanelProvider: WatchPanelProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devdocket.watchUrl',
      wrapCommand('Failed to watch URL', () => handleWatchUrl(watcherRegistry, prWatcherRegistry, watcherService))),
    // Keep the typed commands as back-compat aliases while exposing one unified command in the palette.
    vscode.commands.registerCommand('devdocket.watchRun',
      wrapCommand('Failed to watch URL', () => handleWatchUrl(watcherRegistry, prWatcherRegistry, watcherService))),
    vscode.commands.registerCommand('devdocket.watchPR',
      wrapCommand('Failed to watch URL', () => handleWatchUrl(watcherRegistry, prWatcherRegistry, watcherService))),
    vscode.commands.registerCommand('devdocket.watchPRFromItem',
      wrapCommand('Failed to watch CI from item', (arg: unknown) => handleWatchPRFromItem(watcherRegistry, prWatcherRegistry, watcherService, arg))),
    vscode.commands.registerCommand('devdocket.dismissWatch',
      wrapCommand('Failed to dismiss watch', (arg: unknown) => handleDismissWatch(arg, watcherService))),
    vscode.commands.registerCommand('devdocket.dismissAllCompletedWatches',
      wrapCommand('Failed to dismiss all completed watches', () => handleDismissAllCompletedWatches(watcherService))),
    vscode.commands.registerCommand('devdocket.openWatchUrl',
      wrapCommand('Failed to open watch URL', (arg: unknown) => handleOpenWatchUrl(arg))),
    vscode.commands.registerCommand('devdocket.showWatchesQuickPick',
      wrapCommand('Failed to show watch panel', () => watchPanelProvider.open())),
  );
}
