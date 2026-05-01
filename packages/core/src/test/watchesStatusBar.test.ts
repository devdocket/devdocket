import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter, ThemeColor, window } from 'vscode';
import { WatchesStatusBar } from '../views/watchesStatusBar';

function createWatcherService(watches: any[]) {
  const changeEmitter = new EventEmitter<void>();
  return {
    getActiveWatches: vi.fn(() => watches),
    onDidChangeWatchedRuns: changeEmitter.event,
    _fireChange: () => changeEmitter.fire(),
  };
}

describe('WatchesStatusBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows running, passed, and failed counts with a warning background when failures exist', () => {
    const watcherService = createWatcherService([
      { status: { overallState: 'queued' } },
      { status: { overallState: 'running' } },
      { status: { overallState: 'completed', conclusion: 'success' } },
      { status: { overallState: 'completed', conclusion: 'failure' } },
    ]);

    new WatchesStatusBar(watcherService as any, 'devdocket.showWatchPanel');

    const statusBarItem = (window.createStatusBarItem as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(statusBarItem.text).toBe('🔄 2 running · ✓ 1 passed · ✗ 1 failed');
    expect(statusBarItem.command).toBe('devdocket.showWatchPanel');
    expect(statusBarItem.backgroundColor).toEqual(new ThemeColor('statusBarItem.warningBackground'));
    expect(statusBarItem.color).toEqual(new ThemeColor('statusBarItem.warningForeground'));
    expect(statusBarItem.show).toHaveBeenCalled();
  });

  it('hides the status bar item when there are no active watches', () => {
    const watcherService = createWatcherService([]);

    new WatchesStatusBar(watcherService as any);

    const statusBarItem = (vscode.window.createStatusBarItem as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(statusBarItem.hide).toHaveBeenCalled();
  });
});
