import * as vscode from 'vscode';
import { WatcherService } from '../services/watcherService';

/**
 * Status bar item that shows running/passed/failed watch counts.
 * Click to open the floating watch panel.
 */
export class WatchesStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly watchChangeSub: vscode.Disposable;

  constructor(
    private readonly watcherService: WatcherService,
    command: string = 'devdocket.showWatchesQuickPick',
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100001);
    this.statusBarItem.command = command;
    this.watchChangeSub = watcherService.onDidChangeWatchedRuns(() => {
      this.update();
    });
    this.update();
  }

  private update(): void {
    const watches = this.watcherService.getActiveWatches();
    if (watches.length === 0) {
      this.statusBarItem.text = '👁 Watches';
      this.statusBarItem.tooltip = 'Click to open CI watch details';
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = undefined;
      this.statusBarItem.show();
      return;
    }

    let runningCount = 0;
    let passedCount = 0;
    let failedCount = 0;

    for (const watch of watches) {
      if (watch.hasWarning) {
        failedCount += 1;
        continue;
      }
      if (watch.status.overallState !== 'completed') {
        runningCount += 1;
        continue;
      }
      if (watch.status.conclusion === 'success') {
        passedCount += 1;
        continue;
      }
      failedCount += 1;
    }

    this.statusBarItem.text = `🔄 ${runningCount} running · ✓ ${passedCount} passed · ✗ ${failedCount} failed`;
    this.statusBarItem.tooltip = 'Click to open CI watch details';
    this.statusBarItem.backgroundColor = failedCount > 0
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.statusBarItem.color = failedCount > 0
      ? new vscode.ThemeColor('statusBarItem.warningForeground')
      : undefined;
    this.statusBarItem.show();
  }

  dispose(): void {
    this.watchChangeSub.dispose();
    this.statusBarItem.dispose();
  }
}
