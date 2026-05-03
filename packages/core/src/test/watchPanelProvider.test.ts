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
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
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

  it('assembles PR watches with child runs and standalone run watches from the watcher service', () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);

    const watcherService = {
      getActivePRWatches: vi.fn(() => [{
        identifier: {
          providerId: 'github-pr',
          repo: 'owner/repo',
          prId: '42',
          displayName: 'PR #42',
          url: 'https://github.com/owner/repo/pull/42',
        },
        prState: 'open',
        hasWarning: true,
        errorMessage: 'Polling failed',
      }]),
      getActiveStandaloneWatches: vi.fn(() => [{
        identifier: {
          providerId: 'github-actions',
          runId: '200',
          displayName: 'Deploy',
          url: 'https://github.com/owner/repo/actions/runs/200',
        },
        status: {
          overallState: 'running',
          jobs: [],
          startedAt: new Date(Date.now() - 60_000).toISOString(),
        },
        watchedAt: new Date(Date.now() - 60_000).toISOString(),
      }]),
      getPRWatchKey: vi.fn(() => 'pr:github-pr:owner/repo:42'),
      getChildRuns: vi.fn(() => [{
        identifier: {
          providerId: 'github-actions',
          repo: 'owner/repo',
          runId: '100',
          displayName: 'PR CI',
          url: 'https://github.com/owner/repo/actions/runs/100',
        },
        status: {
          overallState: 'completed',
          conclusion: 'failure',
          jobs: [{ name: 'test', state: 'completed', conclusion: 'failure' }],
          startedAt: new Date(Date.now() - 120_000).toISOString(),
          completedAt: new Date(Date.now() - 30_000).toISOString(),
        },
        watchedAt: new Date(Date.now() - 120_000).toISOString(),
        hasWarning: true,
        errorMessage: '3 consecutive failures',
      }]),
      getProviderLabel: vi.fn(() => 'GitHub Actions'),
      getActiveWatches: vi.fn(() => []),
      dismissAllCompleted: vi.fn(),
      acknowledgeAllFailures: vi.fn(),
      dismissPRWatch: vi.fn(),
      dismissWatch: vi.fn(),
    };

    const provider = new WatchPanelProvider(vscode.Uri.file('C:\\repo') as any, watcherService as any);
    provider.open();

    expect(window.createWebviewPanel).toHaveBeenCalledWith(
      'devdocket.watchPanel',
      'CI Watches',
      vscode.ViewColumn.Beside,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true }),
    );
    expect(mockPanel.panel.title).toBe('CI Watches (2)');
    expect(mockPanel.panel.webview.html).toContain('watchPanel.js');
    expect(mockPanel.panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'updateWatchPanel',
      prWatches: [expect.objectContaining({
        id: 'pr:github-pr:owner/repo:42',
        title: 'PR #42',
        repo: 'owner/repo',
        state: 'open',
        hasWarning: true,
        errorMessage: 'Polling failed',
        runs: [expect.objectContaining({
          id: 'run:github-actions:owner/repo:100',
          name: 'PR CI',
          repo: 'owner/repo',
          state: 'completed',
          conclusion: 'failure',
          hasWarning: true,
          errorMessage: '3 consecutive failures',
          failurePreview: '3 consecutive failures',
        })],
      })],
      runWatches: [expect.objectContaining({
        id: 'run:github-actions::200',
        name: 'Deploy',
        repo: 'GitHub Actions',
        state: 'in_progress',
      })],
    }));
  });

  it('handles dismiss completed, open URL, and dismiss watch webview commands', async () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);

    const prIdentifier = {
      providerId: 'github-pr',
      repo: 'owner/repo',
      prId: '42',
      displayName: 'PR #42',
      url: 'https://github.com/owner/repo/pull/42',
    };
    const runIdentifier = {
      providerId: 'github-actions',
      repo: 'owner/repo',
      runId: '99',
      displayName: 'CI',
      url: 'https://github.com/owner/repo/actions/runs/99',
    };

    const watcherService = {
      getActivePRWatches: vi.fn(() => [{ identifier: prIdentifier, prState: 'open' }]),
      getActiveStandaloneWatches: vi.fn(() => []),
      getPRWatchKey: vi.fn(() => 'pr:github-pr:owner/repo:42'),
      getChildRuns: vi.fn(() => []),
      getProviderLabel: vi.fn(() => 'GitHub Actions'),
      getActiveWatches: vi.fn(() => [{
        identifier: runIdentifier,
        status: { overallState: 'running', jobs: [] },
      }]),
      dismissAllCompleted: vi.fn(),
      acknowledgeAllFailures: vi.fn(),
      dismissPRWatch: vi.fn(),
      dismissWatch: vi.fn(),
    };

    const provider = new WatchPanelProvider(vscode.Uri.file('C:\\repo') as any, watcherService as any);
    provider.open();

    await mockPanel.simulateMessage({ type: 'dismissCompletedWatches' });
    await mockPanel.simulateMessage({ type: 'openWatchUrl', url: runIdentifier.url });
    await mockPanel.simulateMessage({ type: 'openWatchUrl', url: 'javascript:alert(1)' });
    await mockPanel.simulateMessage({ type: 'dismissWatch', watchId: 'pr:github-pr:owner/repo:42' });
    await mockPanel.simulateMessage({ type: 'dismissWatch', watchId: 'run:github-actions:owner/repo:99' });

    expect(watcherService.dismissAllCompleted).toHaveBeenCalled();
    expect(env.openExternal).toHaveBeenCalledTimes(1);
    expect(env.openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'https://github.com/owner/repo/actions/runs/99' }),
    );
    expect(window.showWarningMessage).toHaveBeenCalledWith('Can only open http(s) URLs in the browser.');
    expect(watcherService.dismissPRWatch).toHaveBeenCalledWith(prIdentifier);
    expect(watcherService.dismissWatch).toHaveBeenCalledWith(runIdentifier);
  });
});
