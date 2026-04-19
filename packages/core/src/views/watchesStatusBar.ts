import * as vscode from 'vscode';
import { WatcherService, WatchedRun } from '../services/watcherService';
import { isSafeUrl } from '../utils/url';

/**
 * Status bar item that shows the count of active/failed watches.
 * Click to open quick-pick with all watches.
 */
export class WatchesStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private watchChangeSub: vscode.Disposable;

  constructor(private watcherService: WatcherService) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'devdocket.showWatchesQuickPick';
    
    // Update on watch changes
    this.watchChangeSub = watcherService.onDidChangeWatchedRuns(() => {
      this.update();
    });
    
    this.update();
  }

  private update(): void {
    const watches = this.watcherService.getActiveWatches();
    
    if (watches.length === 0) {
      this.statusBarItem.hide();
      return;
    }

    let runningCount = 0;
    let failedCount = 0;
    let queuedCount = 0;
    
    for (const watch of watches) {
      if (watch.status.overallState === 'queued') {
        queuedCount++;
      } else if (watch.status.overallState === 'running') {
        runningCount++;
      } else if (watch.status.overallState === 'completed' && watch.status.conclusion === 'failure') {
        failedCount++;
      }
    }

    const parts: string[] = [];
    if (failedCount > 0) {
      parts.push(`$(error) ${failedCount} failed`);
    }
    if (runningCount > 0) {
      parts.push(`$(sync~spin) ${runningCount} running`);
    }
    if (queuedCount > 0) {
      parts.push(`$(clock) ${queuedCount} queued`);
    }
    
    // If all completed successfully or in other states, show total count
    if (parts.length === 0) {
      parts.push(`$(check) ${watches.length} completed`);
    }

    this.statusBarItem.text = parts.join(' · ');
    this.statusBarItem.tooltip = 'Click to view watched pipeline runs';
    this.statusBarItem.show();
  }

  dispose(): void {
    this.watchChangeSub.dispose();
    this.statusBarItem.dispose();
  }
}

/**
 * Quick-pick command to show active watches.
 */
export async function showWatchesQuickPick(watcherService: WatcherService): Promise<void> {
  const watches = watcherService.getActiveWatches();
  
  if (watches.length === 0) {
    vscode.window.showInformationMessage('No pipeline runs are being watched.');
    return;
  }

  // Sort: active first, then completed
  const sortedWatches = watches.slice().sort((a, b) => {
    const aCompleted = a.status.overallState === 'completed';
    const bCompleted = b.status.overallState === 'completed';
    if (aCompleted !== bCompleted) {
      return aCompleted ? 1 : -1;
    }
    return 0;
  });

  interface WatchQuickPickItem extends vscode.QuickPickItem {
    watch: WatchedRun;
  }

  const items: WatchQuickPickItem[] = sortedWatches.map(watch => {
    const icon = getIconForWatch(watch);
    const state = watch.status.overallState === 'completed' && watch.status.conclusion
      ? watch.status.conclusion
      : watch.status.overallState;
    
    return {
      label: `${icon} ${watch.identifier.displayName}`,
      description: state,
      detail: watch.identifier.repo,
      watch,
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a pipeline run to open in browser',
  });

  if (selected) {
    const safeUrl = isSafeUrl(selected.watch.identifier.url);
    if (safeUrl) {
      void vscode.env.openExternal(vscode.Uri.parse(safeUrl.href));
    } else {
      void vscode.window.showWarningMessage('Can only open http(s) URLs in the browser.');
    }
  }
}

function getIconForWatch(watch: WatchedRun): string {
  if (watch.hasWarning) {
    return '$(warning)';
  }
  if (watch.status.overallState === 'queued') {
    return '$(clock)';
  }
  if (watch.status.overallState === 'running') {
    return '$(sync~spin)';
  }
  // completed
  if (watch.status.conclusion === 'success') {
    return '$(pass)';
  }
  if (watch.status.conclusion === 'failure') {
    return '$(error)';
  }
  return '$(circle-outline)';
}
