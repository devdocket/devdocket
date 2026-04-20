import * as vscode from 'vscode';
import { WatcherService, type WatchedRun } from '../services/watcherService';
import { WatcherRegistry } from '../services/watcherRegistry';
import { showWatchesQuickPick } from '../views/watchesStatusBar';
import { isSafeUrl } from '../utils/url';
import { wrapCommand, handleCommandError } from './commandUtils';

async function handleWatchRun(watcherRegistry: WatcherRegistry, watcherService: WatcherService): Promise<void> {
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
      if (!watcher) {
        return 'Unsupported URL format. No registered watcher recognizes this URL.';
      }
      return undefined;
    },
  });

  if (!url) {
    return;
  }

  const trimmedUrl = url.trim();

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

async function handleDismissWatch(arg: unknown, watcherService: WatcherService): Promise<void> {
  try {
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
    await vscode.env.openExternal(vscode.Uri.parse(safeUrl.href));
  } catch (err: unknown) {
    handleCommandError('Failed to open URL', err);
  }
}

export function registerWatchCommands(
  context: vscode.ExtensionContext,
  watcherRegistry: WatcherRegistry,
  watcherService: WatcherService,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devdocket.watchRun',
      wrapCommand('Failed to watch pipeline run', () => handleWatchRun(watcherRegistry, watcherService))),
    vscode.commands.registerCommand('devdocket.dismissWatch',
      wrapCommand('Failed to dismiss watch', (arg: unknown) => handleDismissWatch(arg, watcherService))),
    vscode.commands.registerCommand('devdocket.dismissAllCompletedWatches',
      wrapCommand('Failed to dismiss all completed watches', () => handleDismissAllCompletedWatches(watcherService))),
    vscode.commands.registerCommand('devdocket.openWatchUrl',
      wrapCommand('Failed to open watch URL', (arg: unknown) => handleOpenWatchUrl(arg))),
    vscode.commands.registerCommand('devdocket.showWatchesQuickPick',
      wrapCommand('Failed to show watches quick pick', () => showWatchesQuickPick(watcherService))),
  );
}
