import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { env, window } from 'vscode';
import { WatchPanelProvider } from '../views/watchPanelProvider';

type MessageHandler = (message: unknown) => void | Promise<void>;
type DisposeHandler = () => void;

function createMockWebviewPanel() {
  let messageHandler: MessageHandler | undefined;
  let disposeHandler: DisposeHandler | undefined;
  const panel = {
    title: '',
    webview: {
      html: '',
      asWebviewUri: vi.fn((uri: { fsPath?: string; path?: string; toString?: () => string }) => ({
        toString: () => `webview-resource:${uri.fsPath ?? uri.path ?? uri.toString?.() ?? ''}`,
      })),
      onDidReceiveMessage: vi.fn((handler: MessageHandler) => {
        messageHandler = handler;
        return { dispose: vi.fn(() => { messageHandler = undefined; }) };
      }),
      postMessage: vi.fn(async () => true),
    },
    onDidDispose: vi.fn((handler: DisposeHandler) => {
      disposeHandler = handler;
      return { dispose: vi.fn() };
    }),
    dispose: vi.fn(),
    reveal: vi.fn(),
  };

  return {
    panel,
    simulateMessage: (message: unknown) => messageHandler?.(message) ?? Promise.resolve(),
    simulateDispose: () => disposeHandler?.(),
  };
}

describe('WatchPanelProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the panel and posts grouped watch data', () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);

    const watcherService = {
      getActivePRWatches: vi.fn(() => [{
        identifier: { providerId: 'github-pr', repo: 'owner/repo', prId: '42', displayName: 'PR #42', url: 'https://github.com/owner/repo/pull/42' },
        prState: 'open',
      }]),
      getActiveStandaloneWatches: vi.fn(() => [{
        identifier: { providerId: 'github-actions', repo: 'owner/repo', runId: '99', displayName: 'CI', url: 'https://github.com/owner/repo/actions/runs/99' },
        status: { overallState: 'completed', conclusion: 'success', jobs: [], startedAt: new Date(Date.now() - 60_000).toISOString() },
        watchedAt: new Date(Date.now() - 60_000).toISOString(),
      }]),
      getPRWatchKey: vi.fn(() => 'pr:github-pr:owner/repo:42'),
      getChildRuns: vi.fn(() => [{
        identifier: { providerId: 'github-actions', repo: 'owner/repo', runId: '100', displayName: 'PR CI', url: 'https://github.com/owner/repo/actions/runs/100' },
        status: {
          overallState: 'completed',
          conclusion: 'failure',
          jobs: [{ name: 'test', state: 'completed', conclusion: 'failure' }],
          startedAt: new Date(Date.now() - 120_000).toISOString(),
        },
        watchedAt: new Date(Date.now() - 120_000).toISOString(),
      }]),
      getProviderLabel: vi.fn(() => 'GitHub Actions'),
      getActiveWatches: vi.fn(() => []),
      dismissAllCompleted: vi.fn(),
      dismissPRWatch: vi.fn(),
      dismissWatch: vi.fn(),
    };

    const provider = new WatchPanelProvider({ fsPath: 'C:\\repo' } as any, watcherService as any);
    provider.open();

    expect(window.createWebviewPanel).toHaveBeenCalledWith(
      'devdocket.watchPanel',
      'CI Watches',
      vscode.ViewColumn.Beside,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true }),
    );
    expect(mockPanel.panel.webview.html).toContain('watchPanel.js');
    expect(mockPanel.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'updateWatchPanel',
      prWatches: [expect.objectContaining({ title: 'PR #42' })],
      runWatches: [expect.objectContaining({ name: 'CI' })],
    }));
  });

  it('handles webview commands for dismissing and opening watches', async () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);

    const prIdentifier = { providerId: 'github-pr', repo: 'owner/repo', prId: '42', displayName: 'PR #42', url: 'https://github.com/owner/repo/pull/42' };
    const runIdentifier = { providerId: 'github-actions', repo: 'owner/repo', runId: '99', displayName: 'CI', url: 'https://github.com/owner/repo/actions/runs/99' };
    const watcherService = {
      getActivePRWatches: vi.fn(() => [{ identifier: prIdentifier, prState: 'open' }]),
      getActiveStandaloneWatches: vi.fn(() => []),
      getPRWatchKey: vi.fn(() => 'pr:github-pr:owner/repo:42'),
      getChildRuns: vi.fn(() => []),
      getProviderLabel: vi.fn(() => 'GitHub Actions'),
      getActiveWatches: vi.fn(() => [{ identifier: runIdentifier, status: { overallState: 'running', jobs: [] } }]),
      dismissAllCompleted: vi.fn(),
      dismissPRWatch: vi.fn(),
      dismissWatch: vi.fn(),
    };

    const provider = new WatchPanelProvider({ fsPath: 'C:\\repo' } as any, watcherService as any);
    provider.open();

    await mockPanel.simulateMessage({ type: 'dismissCompletedWatches' });
    await mockPanel.simulateMessage({ type: 'openWatchUrl', url: runIdentifier.url });
    await mockPanel.simulateMessage({ type: 'dismissWatch', watchId: 'pr:github-pr:owner/repo:42' });
    await mockPanel.simulateMessage({ type: 'dismissWatch', watchId: 'run:github-actions:owner/repo:99' });

    expect(watcherService.dismissAllCompleted).toHaveBeenCalled();
    expect(env.openExternal).toHaveBeenCalledTimes(1);
    expect(watcherService.dismissPRWatch).toHaveBeenCalledWith(prIdentifier);
    expect(watcherService.dismissWatch).toHaveBeenCalledWith(runIdentifier);
  });
});
