import * as vscode from 'vscode';
import { WatcherService, type WatchedRun, type WatchedPR } from '../services/watcherService';
import { WatcherRegistry } from '../services/watcherRegistry';
import { PRWatcherRegistry } from '../services/prWatcherRegistry';
import type { WatchPanelProvider } from '../views/watchPanelProvider';
import { isSafeUrl } from '../utils/url';
import { wrapCommand, handleCommandError } from './commandUtils';

async function handleWatchRun(watcherRegistry: WatcherRegistry, prWatcherRegistry: PRWatcherRegistry, watcherService: WatcherService): Promise<void> {
  const url = await vscode.window.showInputBox({
    prompt: 'Enter a pipeline run URL',
    placeHolder: 'https://github.com/owner/repo/actions/runs/123456789',
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'URL cannot be empty';
      }
      if (!isSafeUrl(trimmed)) {
        return 'Only http(s) URLs are supported.';
      }
      const watcher = watcherRegistry.findWatcherForUrl(trimmed);
      const prWatcher = prWatcherRegistry.findWatcherForUrl(trimmed);
      if (!watcher && !prWatcher) {
        return 'Unsupported URL format. No registered watcher recognizes this URL.';
      }
      return undefined;
    },
  });

  if (!url) {
    return;
  }

  const trimmedUrl = url.trim();

  // If a PR watcher recognizes the URL, redirect to PR watch flow
  const prWatcher = prWatcherRegistry.findWatcherForUrl(trimmedUrl);
  if (prWatcher) {
    try {
      const identifier = prWatcher.parsePRUrl(trimmedUrl);
      await watcherService.startPRWatch(identifier);
      void vscode.window.showInformationMessage(`Now watching PR: ${identifier.displayName}`);
    } catch (err: unknown) {
      handleCommandError('Failed to watch PR', err);
    }
    return;
  }

  try {
    const watcher = watcherRegistry.findWatcherForUrl(trimmedUrl);
    if (!watcher) {
      void vscode.window.showErrorMessage('Unsupported URL format. No registered watcher recognizes this URL.');
      return;
    }

    const identifier = watcher.parseRunUrl(trimmedUrl);
    await watcherService.startWatch(identifier);
    
    void vscode.window.showInformationMessage(`Now watching: ${identifier.displayName}`);
  } catch (err: unknown) {
    handleCommandError('Failed to watch pipeline run', err);
  }
}

async function handleWatchPR(prWatcherRegistry: PRWatcherRegistry, watcherService: WatcherService): Promise<void> {
  const url = await vscode.window.showInputBox({
    prompt: 'Enter a pull request URL',
    placeHolder: 'https://github.com/owner/repo/pull/42',
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'URL cannot be empty';
      }
      if (!isSafeUrl(trimmed)) {
        return 'Only http(s) URLs are supported.';
      }
      const watcher = prWatcherRegistry.findWatcherForUrl(trimmed);
      if (!watcher) {
        return 'Unsupported URL format. No registered PR watcher recognizes this URL.';
      }
      return undefined;
    },
  });

  if (!url) {
    return;
  }

  const trimmedUrl = url.trim();

  try {
    const prWatcher = prWatcherRegistry.findWatcherForUrl(trimmedUrl);
    if (!prWatcher) {
      void vscode.window.showErrorMessage('Unsupported URL format. No registered PR watcher recognizes this URL.');
      return;
    }

    const identifier = prWatcher.parsePRUrl(trimmedUrl);
    await watcherService.startPRWatch(identifier);
    void vscode.window.showInformationMessage(`Now watching PR: ${identifier.displayName}`);
  } catch (err: unknown) {
    handleCommandError('Failed to watch PR', err);
  }
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
    await watcherService.startPRWatch(identifier);
    void vscode.window.showInformationMessage(`Now watching PR: ${identifier.displayName}`);
    return;
  }

  const runWatcher = watcherRegistry.findWatcherForUrl(safeUrl.href);
  if (runWatcher) {
    const identifier = runWatcher.parseRunUrl(safeUrl.href);
    await watcherService.startWatch(identifier);
    void vscode.window.showInformationMessage(`Now watching run: ${identifier.displayName}`);
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
    vscode.commands.registerCommand('devdocket.watchRun',
      wrapCommand('Failed to watch pipeline run', () => handleWatchRun(watcherRegistry, prWatcherRegistry, watcherService))),
    vscode.commands.registerCommand('devdocket.watchPR',
      wrapCommand('Failed to watch PR', () => handleWatchPR(prWatcherRegistry, watcherService))),
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
