import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter, ThemeColor, window } from 'vscode';
import { WatchesStatusBar } from '../views/watchesStatusBar';

function createWatcherService(initialWatches: any[]) {
  const changeEmitter = new EventEmitter<void>();
  let watches = initialWatches;
  return {
    getActiveWatches: vi.fn(() => watches),
    onDidChangeWatchedRuns: changeEmitter.event,
    setWatches: (nextWatches: any[]) => {
      watches = nextWatches;
      changeEmitter.fire();
    },
  };
}

describe('WatchesStatusBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats running, passed, and failed counts and wires the click command', () => {
    const watcherService = createWatcherService([
      { status: { overallState: 'queued' } },
      { status: { overallState: 'running' } },
      { status: { overallState: 'completed', conclusion: 'success' } },
      { status: { overallState: 'completed', conclusion: 'failure' } },
      { hasWarning: true, status: { overallState: 'completed', conclusion: 'success' } },
    ]);

    new WatchesStatusBar(watcherService as any);

    const statusBarItem = (window.createStatusBarItem as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(statusBarItem.text).toBe('🔄 2 running · ✓ 1 passed · ✗ 2 failed');
    expect(statusBarItem.command).toBe('devdocket.showWatchesQuickPick');
    expect(statusBarItem.tooltip).toBe('Click to open CI watch details');
    expect(statusBarItem.backgroundColor).toEqual(new ThemeColor('statusBarItem.warningBackground'));
    expect(statusBarItem.color).toEqual(new ThemeColor('statusBarItem.warningForeground'));
    expect(statusBarItem.show).toHaveBeenCalled();
  });

  it('updates visibility and text when watch activity changes', () => {
    const watcherService = createWatcherService([]);
    new WatchesStatusBar(watcherService as any, 'devdocket.showWatchPanel');

    const statusBarItem = (vscode.window.createStatusBarItem as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(statusBarItem.command).toBe('devdocket.showWatchPanel');
    expect(statusBarItem.hide).toHaveBeenCalledTimes(1);

    watcherService.setWatches([{ status: { overallState: 'running' } }]);
    expect(statusBarItem.text).toBe('🔄 1 running · ✓ 0 passed · ✗ 0 failed');
    expect(statusBarItem.show).toHaveBeenCalledTimes(1);

    watcherService.setWatches([]);
    expect(statusBarItem.hide).toHaveBeenCalledTimes(2);
  });
});
