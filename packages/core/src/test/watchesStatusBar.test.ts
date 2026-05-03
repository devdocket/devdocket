import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter, ThemeColor, window } from 'vscode';
import { WatchesStatusBar } from '../views/watchesStatusBar';

function createWatcherService(initialWatches: any[]) {
  const changeEmitter = new EventEmitter<void>();
  let watches = initialWatches;
  return {
    getActiveWatches: vi.fn(() => watches),
    isFailureAcknowledged: vi.fn(() => false),
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
    expect(statusBarItem.text).toBe('🔄 2 active · ✓ 1 passed · ✗ 2 failed');
    expect(statusBarItem.command).toBe('devdocket.showWatchesQuickPick');
    expect(statusBarItem.tooltip).toBe('Click to open CI watch details');
    expect(statusBarItem.backgroundColor).toEqual(new ThemeColor('statusBarItem.warningBackground'));
    expect(statusBarItem.color).toEqual(new ThemeColor('statusBarItem.warningForeground'));
    expect(statusBarItem.show).toHaveBeenCalled();
  });

  it('updates text when watch activity changes and remains visible when empty', () => {
    const watcherService = createWatcherService([]);
    new WatchesStatusBar(watcherService as any, 'devdocket.showWatchPanel');

    const statusBarItem = (vscode.window.createStatusBarItem as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(statusBarItem.command).toBe('devdocket.showWatchPanel');
    expect(statusBarItem.text).toBe('👁 Watches');
    expect(statusBarItem.show).toHaveBeenCalledTimes(1);
    expect(statusBarItem.hide).not.toHaveBeenCalled();

    watcherService.setWatches([{ status: { overallState: 'running' } }]);
    expect(statusBarItem.text).toBe('🔄 1 active · ✓ 0 passed · ✗ 0 failed');
    expect(statusBarItem.show).toHaveBeenCalledTimes(2);

    watcherService.setWatches([]);
    expect(statusBarItem.text).toBe('👁 Watches');
    expect(statusBarItem.show).toHaveBeenCalledTimes(3);
    expect(statusBarItem.hide).not.toHaveBeenCalled();
  });
});
