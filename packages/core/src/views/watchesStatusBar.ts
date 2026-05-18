import * as vscode from 'vscode';
import { WatcherService } from '../services/watcherService';
import { affectsStatusBarLogoIconSetting, shouldUseStatusBarLogoIcon, statusBarLogoThemeIcon } from './statusBarBrand';

function getWatchesStatusBarBrandPrefix(): string {
  // The eye emoji is the text-mode brand marker for watches; the logo setting replaces it so the glyph is visually primary.
  return shouldUseStatusBarLogoIcon() ? statusBarLogoThemeIcon : '👁 DevDocket';
}

/**
 * Status bar item that shows running/passed/failed watch counts.
 * Click to open the floating watch panel.
 */
export class WatchesStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly watchChangeSub: vscode.Disposable;
  private readonly configurationSub: vscode.Disposable;

  constructor(
    private readonly watcherService: WatcherService,
    command: string = 'devdocket.showWatchesQuickPick',
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100001);
    this.statusBarItem.command = command;
    this.watchChangeSub = watcherService.onDidChangeWatchedRuns(() => {
      this.update();
    });
    this.configurationSub = vscode.workspace.onDidChangeConfiguration(event => {
      if (affectsStatusBarLogoIconSetting(event)) {
        this.update();
      }
    });
    this.update();
  }

  private update(): void {
    const watches = this.watcherService.getActiveWatches();
    const brandPrefix = getWatchesStatusBarBrandPrefix();
    if (watches.length === 0) {
      this.statusBarItem.text = `${brandPrefix} • Watches`;
      this.statusBarItem.tooltip = this.buildTooltip(0, 0, 0);
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = undefined;
      this.statusBarItem.show();
      return;
    }

    let runningCount = 0;
    let passedCount = 0;
    let failedCount = 0;
    let unacknowledgedFailedCount = 0;

    for (const watch of watches) {
      if (watch.hasWarning) {
        // hasWarning means we couldn't poll the run successfully — surface
        // it as an alert in the status bar so the user knows something's
        // wrong, but don't conflate it with a CI failure conclusion.
        failedCount += 1;
        if (!this.watcherService.isFailureAcknowledged(watch)) {
          unacknowledgedFailedCount += 1;
        }
        continue;
      }
      if (watch.status.overallState !== 'completed') {
        runningCount += 1;
        continue;
      }
      const conclusion = watch.status.conclusion;
      if (conclusion === undefined || conclusion === 'success') {
        passedCount += 1;
        continue;
      }
      // cancelled / skipped / neutral are explicit non-results, not failures.
      // Mirrors the canonical isFailedRun in mainViewProvider.ts and the
      // watch panel webview so the status bar agrees with the panel UI.
      if (conclusion === 'cancelled' || conclusion === 'skipped' || conclusion === 'neutral') {
        passedCount += 1;
        continue;
      }
      failedCount += 1;
      if (!this.watcherService.isFailureAcknowledged(watch)) {
        unacknowledgedFailedCount += 1;
      }
    }

    this.statusBarItem.text = `${brandPrefix} • 🔄 ${runningCount} · ✓ ${passedCount} · ✗ ${failedCount}`;
    this.statusBarItem.tooltip = this.buildTooltip(runningCount, passedCount, failedCount);
    // Only highlight the status bar with the warning color if there is at
    // least one failed watch the user hasn't seen yet — once they open the
    // watch panel, acknowledge clears the alert until a NEW failure arrives.
    this.statusBarItem.backgroundColor = unacknowledgedFailedCount > 0
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.statusBarItem.color = unacknowledgedFailedCount > 0
      ? new vscode.ThemeColor('statusBarItem.warningForeground')
      : undefined;
    this.statusBarItem.show();
  }

  private buildTooltip(runningCount: number, passedCount: number, failedCount: number): string {
    return [
      'DevDocket CI Watches',
      `  🔄 ${runningCount} running`,
      `  ✓ ${passedCount} passed`,
      `  ✗ ${failedCount} failed`,
      'Click to open CI Watches panel.',
    ].join('\n');
  }

  dispose(): void {
    this.watchChangeSub.dispose();
    this.configurationSub.dispose();
    this.statusBarItem.dispose();
  }
}
