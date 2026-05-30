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

function createMockWorkGraph(items: any[] = []) {
  const changeEmitter = new vscode.EventEmitter<void>();
  return {
    getAll: vi.fn(() => items),
    getItem: vi.fn((id: string) => items.find(item => item.id === id)),
    onDidChange: changeEmitter.event,
    fireDidChange: () => changeEmitter.fire(),
  };
}

function createMockProviderRegistry(itemsByProvider = new Map<string, any[]>()) {
  return {
    getAllProviderItems: vi.fn(() => itemsByProvider),
    onDidChangeProviderItems: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function createPRWatch(prId = '42', repo = 'owner/repo', providerId = 'github-pr') {
  return {
    identifier: {
      providerId,
      repo,
      prId,
      displayName: `PR #${prId}`,
      url: providerId === 'ado-pr'
        ? `https://dev.azure.com/${repo.replace(/\//g, '/_git/')}/pullrequest/${prId}`
        : `https://github.com/${repo}/pull/${prId}`,
    },
    prState: 'open',
  };
}

function createChildRun(prId = '42') {
  return {
    identifier: {
      providerId: 'github-actions',
      repo: 'owner/repo',
      runId: `100-${prId}`,
      displayName: 'PR CI',
      url: `https://github.com/owner/repo/actions/runs/100${prId}`,
    },
    status: {
      overallState: 'completed',
      conclusion: 'success',
      jobs: [],
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      completedAt: new Date(Date.now() - 30_000).toISOString(),
    },
    watchedAt: new Date(Date.now() - 120_000).toISOString(),
  };
}

function createWatcherService(prWatches: any[] = []) {
  return {
    getActivePRWatches: vi.fn(() => prWatches),
    getActiveStandaloneWatches: vi.fn(() => []),
    getPRWatchKey: vi.fn((identifier: { providerId: string; repo: string; prId: string }) => `pr:${identifier.providerId}:${identifier.repo}:${identifier.prId}`),
    getChildRuns: vi.fn((_prKey: string) => [createChildRun()]),
    getProviderLabel: vi.fn(() => 'GitHub Actions'),
    getActiveWatches: vi.fn(() => []),
    dismissAllCompleted: vi.fn(),
    acknowledgeAllFailures: vi.fn(),
    dismissPRWatch: vi.fn(),
    dismissWatch: vi.fn(),
  };
}

function getUpdateWatchPanelMessage(mockPanel: ReturnType<typeof createMockWebviewPanel>) {
  return vi.mocked(mockPanel.panel.webview.postMessage).mock.calls.at(-1)?.[0] as any;
}

describe('WatchPanelProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads codicons from the bundled webview assets', () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);

    const provider = new WatchPanelProvider(
      vscode.Uri.file('C:\\repo') as any,
      createWatcherService() as any,
      createMockWorkGraph(),
      createMockProviderRegistry() as any,
    );
    provider.open();

    const options = vi.mocked(window.createWebviewPanel).mock.calls[0][3] as { localResourceRoots?: Array<{ fsPath?: string }> };
    expect(options.localResourceRoots).toEqual(expect.arrayContaining([
      expect.objectContaining({ fsPath: 'C:\\repo\\webview-dist' }),
    ]));
    expect(mockPanel.panel.webview.html).toContain('webview-resource:C:\\repo\\webview-dist\\codicons\\codicon.css');
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

    const provider = new WatchPanelProvider(
      vscode.Uri.file('C:\\repo') as any,
      watcherService as any,
      createMockWorkGraph(),
      createMockProviderRegistry() as any,
    );
    provider.open();

    expect(window.createWebviewPanel).toHaveBeenCalledWith(
      'devdocket.watchPanel',
      'CI Watches',
      vscode.ViewColumn.Beside,
      expect.objectContaining({ enableScripts: true }),
    );
    expect(mockPanel.panel.title).toBe('CI Watches (2)');
    expect(mockPanel.panel.webview.html).toContain('watchPanel.js');
    const message = getUpdateWatchPanelMessage(mockPanel);
    expect(message.prWatches).toHaveLength(1);
    expect(message.prWatches[0].runs).toHaveLength(1);
    expect(message.runWatches).toHaveLength(1);
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

  it('uses title-cased partial-success previews in watch panel data', () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
    const watcherService = createWatcherService();
    vi.mocked(watcherService.getActiveStandaloneWatches).mockReturnValue([{
      identifier: {
        providerId: 'ado-pipelines',
        runId: '570',
        displayName: 'Publish artifacts',
        url: 'https://dev.azure.com/org/project/_build/results?buildId=570',
      },
      status: {
        overallState: 'completed',
        conclusion: 'partial_success',
        jobs: [],
      },
      watchedAt: new Date(Date.now() - 120_000).toISOString(),
    }]);

    const provider = new WatchPanelProvider(
      vscode.Uri.file('C:\\repo') as any,
      watcherService as any,
      createMockWorkGraph(),
      createMockProviderRegistry() as any,
    );
    provider.open();

    const message = getUpdateWatchPanelMessage(mockPanel);
    expect(message.runWatches[0]).toEqual(expect.objectContaining({
      state: 'completed',
      conclusion: 'partial_success',
      failurePreview: 'Conclusion: Succeeded with issues',
    }));
  });

  it('adds linkedItemId when a matching PR work item exists', () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
    const watcherService = createWatcherService([createPRWatch()]);
    const workGraph = createMockWorkGraph([{
      id: 'work-42',
      providerId: 'github-my-prs',
      externalId: 'owner/repo#42',
      itemType: 'pr',
    }]);

    const provider = new WatchPanelProvider(
      vscode.Uri.file('C:\\repo') as any,
      watcherService as any,
      workGraph as any,
      createMockProviderRegistry() as any,
    );
    provider.open();

    const message = getUpdateWatchPanelMessage(mockPanel);
    expect(message.prWatches[0]).toEqual(expect.objectContaining({
      id: 'pr:github-pr:owner/repo:42',
      linkedItemId: 'work-42',
    }));
    expect(message.prWatches[0]).not.toHaveProperty('linkedSourceProviderId');
    expect(message.prWatches[0]).not.toHaveProperty('linkedSourceExternalId');
    expect(workGraph.getAll).toHaveBeenCalledTimes(1);
  });

  it('adds linked source provider and external IDs when only a matching provider PR exists', () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
    const watcherService = createWatcherService([createPRWatch()]);
    const providerItems = new Map<string, any[]>([
      ['github-pr-reviews', [{ externalId: 'owner/repo#42', title: 'Review PR', itemType: 'pr' }]],
    ]);
    const providerRegistry = createMockProviderRegistry(providerItems);

    const provider = new WatchPanelProvider(
      vscode.Uri.file('C:\\repo') as any,
      watcherService as any,
      createMockWorkGraph(),
      providerRegistry as any,
    );
    provider.open();

    const message = getUpdateWatchPanelMessage(mockPanel);
    expect(message.prWatches[0]).toEqual(expect.objectContaining({
      id: 'pr:github-pr:owner/repo:42',
      linkedSourceProviderId: 'github-pr-reviews',
      linkedSourceExternalId: 'owner/repo#42',
    }));
    expect(message.prWatches[0]).not.toHaveProperty('linkedItemId');
    expect(providerRegistry.getAllProviderItems).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe to provider item changes for watch panel refreshes', () => {
    const providerRegistry = createMockProviderRegistry();

    new WatchPanelProvider(
      vscode.Uri.file('C:\\repo') as any,
      createWatcherService() as any,
      createMockWorkGraph(),
      providerRegistry as any,
    );

    expect(providerRegistry.onDidChangeProviderItems).not.toHaveBeenCalled();
  });

  it('omits DevDocket link data when no matching PR item exists', () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
    const watcherService = createWatcherService([createPRWatch()]);

    const provider = new WatchPanelProvider(
      vscode.Uri.file('C:\\repo') as any,
      watcherService as any,
      createMockWorkGraph([{ id: 'issue-42', providerId: 'github', externalId: 'owner/repo#42', itemType: 'issue' }]),
      createMockProviderRegistry() as any,
    );
    provider.open();

    const prWatch = getUpdateWatchPanelMessage(mockPanel).prWatches[0];
    expect(prWatch).not.toHaveProperty('linkedItemId');
    expect(prWatch).not.toHaveProperty('linkedSourceProviderId');
    expect(prWatch).not.toHaveProperty('linkedSourceExternalId');
  });

  it('refreshes linked PR targets when work items change', () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
    const watcherService = createWatcherService([createPRWatch()]);
    const workItems: any[] = [];
    const workGraph = createMockWorkGraph(workItems);

    const provider = new WatchPanelProvider(
      vscode.Uri.file('C:\\repo') as any,
      watcherService as any,
      workGraph as any,
      createMockProviderRegistry() as any,
    );
    provider.open();

    expect(getUpdateWatchPanelMessage(mockPanel).prWatches[0]).not.toHaveProperty('linkedItemId');
    const initialPostCount = vi.mocked(mockPanel.panel.webview.postMessage).mock.calls.length;

    workItems.push({ id: 'work-42', providerId: 'github-my-prs', externalId: 'owner/repo#42', itemType: 'pr' });
    workGraph.fireDidChange();
    expect(mockPanel.panel.webview.postMessage).toHaveBeenCalledTimes(initialPostCount + 1);
    expect(getUpdateWatchPanelMessage(mockPanel).prWatches[0]).toEqual(expect.objectContaining({
      linkedItemId: 'work-42',
    }));
  });

  it('resolves PR links across PR-emitting provider IDs instead of the watcher provider ID', () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
    const watcherService = createWatcherService([createPRWatch()]);

    const provider = new WatchPanelProvider(
      vscode.Uri.file('C:\\repo') as any,
      watcherService as any,
      createMockWorkGraph([{
        id: 'review-work-42',
        providerId: 'github-pr-reviews',
        externalId: 'owner/repo#42',
        itemType: 'pr',
      }]),
      createMockProviderRegistry() as any,
    );
    provider.open();

    expect(getUpdateWatchPanelMessage(mockPanel).prWatches[0]).toEqual(expect.objectContaining({
      id: 'pr:github-pr:owner/repo:42',
      linkedItemId: 'review-work-42',
    }));
  });

  it('resolves ADO PR watches using the ADO provider externalId format', () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
    const watcherService = createWatcherService([createPRWatch('42', 'org/project/repo', 'ado-pr')]);

    const provider = new WatchPanelProvider(
      vscode.Uri.file('C:\\repo') as any,
      watcherService as any,
      createMockWorkGraph([{
        id: 'ado-work-42',
        providerId: 'ado-my-prs',
        externalId: 'org/project/repo/42',
        itemType: 'pr',
      }]),
      createMockProviderRegistry() as any,
    );
    provider.open();

    expect(getUpdateWatchPanelMessage(mockPanel).prWatches[0]).toEqual(expect.objectContaining({
      id: 'pr:ado-pr:org/project/repo:42',
      linkedItemId: 'ado-work-42',
    }));
  });

  it('validates source link fields before previewing incoming items', async () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);

    const provider = new WatchPanelProvider(
      vscode.Uri.file('C:\\repo') as any,
      createWatcherService() as any,
      createMockWorkGraph(),
      createMockProviderRegistry() as any,
    );
    provider.open();

    await mockPanel.simulateMessage({
      type: 'openItem',
      itemId: 'github-pr-reviews::owner/repo#42',
      providerId: 42,
      externalId: {},
    } as any);
    await mockPanel.simulateMessage({
      type: 'openItem',
      itemId: ['not-a-key'],
      providerId: 'github-pr-reviews',
      externalId: 'owner/repo#42',
    } as any);

    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.previewIncomingItem', {
      providerId: 'github-pr-reviews',
      externalId: 'owner/repo#42',
    });
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
    const workGraph = createMockWorkGraph([{ id: 'work-42' }]);

    const provider = new WatchPanelProvider(
      vscode.Uri.file('C:\\repo') as any,
      watcherService as any,
      workGraph as any,
      createMockProviderRegistry() as any,
    );
    provider.open();

    await mockPanel.simulateMessage({ type: 'dismissCompletedWatches' });
    await mockPanel.simulateMessage({ type: 'addWatchUrl' });
    await mockPanel.simulateMessage({ type: 'openWatchUrl', url: runIdentifier.url });
    await mockPanel.simulateMessage({ type: 'openWatchUrl', url: 'javascript:alert(1)' });
    await mockPanel.simulateMessage({ type: 'openItem', itemId: 'work-42' });
    await mockPanel.simulateMessage({
      type: 'openItem',
      itemId: 'github-pr-reviews::owner/repo#42',
      providerId: 'github-pr-reviews',
      externalId: 'owner/repo#42',
    });
    await mockPanel.simulateMessage({ type: 'dismissWatch', watchId: 'pr:github-pr:owner/repo:42' });
    await mockPanel.simulateMessage({ type: 'dismissWatch', watchId: 'run:github-actions:owner/repo:99' });

    // dismissCompletedWatches now routes through the shared command so the
    // confirmation prompt and logging stay in one place.
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.dismissAllCompletedWatches');
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.watchUrl');
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.editItem', { id: 'work-42' });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.previewIncomingItem', {
      providerId: 'github-pr-reviews',
      externalId: 'owner/repo#42',
    });
    expect(env.openExternal).toHaveBeenCalledTimes(1);
    expect(env.openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'https://github.com/owner/repo/actions/runs/99' }),
    );
    expect(window.showWarningMessage).toHaveBeenCalledWith('Can only open http(s) URLs in the browser.');
    expect(watcherService.dismissPRWatch).toHaveBeenCalledWith(prIdentifier);
    expect(watcherService.dismissWatch).toHaveBeenCalledWith(runIdentifier);
  });

  describe('focus-watch plumbing', () => {
    function getFocusWatchMessages(mockPanel: ReturnType<typeof createMockWebviewPanel>) {
      return vi.mocked(mockPanel.panel.webview.postMessage).mock.calls
        .map(call => call[0] as { type?: string })
        .filter(message => message?.type === 'focusWatch');
    }

    it('posts focusWatch for a work-item target once the webview signals readiness', async () => {
      const mockPanel = createMockWebviewPanel();
      vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
      const watcherService = createWatcherService([createPRWatch()]);
      const workGraph = createMockWorkGraph([{
        id: 'work-42',
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
        itemType: 'pr',
      }]);
      const provider = new WatchPanelProvider(
        vscode.Uri.file('C:\\repo') as any,
        watcherService as any,
        workGraph as any,
        createMockProviderRegistry() as any,
      );

      provider.open({ focusItemId: 'work-42' });

      // Webview hasn't acknowledged readiness yet → no focusWatch should be sent.
      expect(getFocusWatchMessages(mockPanel)).toEqual([]);

      // Buffer flushes after watchPanelReady fires.
      await mockPanel.simulateMessage({ type: 'watchPanelReady' });

      expect(getFocusWatchMessages(mockPanel)).toEqual([
        { type: 'focusWatch', watchId: 'pr:github-pr:owner/repo:42' },
      ]);
    });

    it('posts focusWatch immediately when the panel is already ready', async () => {
      const mockPanel = createMockWebviewPanel();
      vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
      const watcherService = createWatcherService([createPRWatch()]);
      const workGraph = createMockWorkGraph([{
        id: 'work-42',
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
        itemType: 'pr',
      }]);
      const provider = new WatchPanelProvider(
        vscode.Uri.file('C:\\repo') as any,
        watcherService as any,
        workGraph as any,
        createMockProviderRegistry() as any,
      );

      provider.open();
      await mockPanel.simulateMessage({ type: 'watchPanelReady' });
      expect(getFocusWatchMessages(mockPanel)).toEqual([]);

      provider.open({ focusItemId: 'work-42' });

      expect(getFocusWatchMessages(mockPanel)).toEqual([
        { type: 'focusWatch', watchId: 'pr:github-pr:owner/repo:42' },
      ]);
    });

    it('resolves provider identity targets against linked source PRs', async () => {
      const mockPanel = createMockWebviewPanel();
      vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
      const watcherService = createWatcherService([createPRWatch()]);
      const providerItems = new Map<string, any[]>([
        ['github-pr-reviews', [{ externalId: 'owner/repo#42', title: 'Review PR', itemType: 'pr' }]],
      ]);
      const provider = new WatchPanelProvider(
        vscode.Uri.file('C:\\repo') as any,
        watcherService as any,
        createMockWorkGraph(),
        createMockProviderRegistry(providerItems) as any,
      );

      provider.open({ focusProviderId: 'github-pr-reviews', focusExternalId: 'owner/repo#42' });
      await mockPanel.simulateMessage({ type: 'watchPanelReady' });

      expect(getFocusWatchMessages(mockPanel)).toEqual([
        { type: 'focusWatch', watchId: 'pr:github-pr:owner/repo:42' },
      ]);
    });

    it('does not post focusWatch when no PR watch matches the target', async () => {
      const mockPanel = createMockWebviewPanel();
      vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
      const watcherService = createWatcherService([createPRWatch()]);
      const provider = new WatchPanelProvider(
        vscode.Uri.file('C:\\repo') as any,
        watcherService as any,
        createMockWorkGraph(),
        createMockProviderRegistry() as any,
      );

      provider.open({ focusItemId: 'unknown-work-item' });
      await mockPanel.simulateMessage({ type: 'watchPanelReady' });

      expect(getFocusWatchMessages(mockPanel)).toEqual([]);
      // The standard updateWatchPanel snapshot is still posted so the panel renders.
      const update = getUpdateWatchPanelMessage(mockPanel);
      expect(update.type).toBe('updateWatchPanel');
      expect(update.prWatches).toHaveLength(1);
    });

    it('resolves a synthetic providerId::externalId focusItemId when no work item exists', async () => {
      const mockPanel = createMockWebviewPanel();
      vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
      const watcherService = createWatcherService([createPRWatch()]);
      const providerItems = new Map<string, any[]>([
        ['github-pr-reviews', [{ externalId: 'owner/repo#42', title: 'Review PR', itemType: 'pr' }]],
      ]);
      const provider = new WatchPanelProvider(
        vscode.Uri.file('C:\\repo') as any,
        watcherService as any,
        createMockWorkGraph(),
        createMockProviderRegistry(providerItems) as any,
      );

      provider.open({ focusItemId: 'github-pr-reviews::owner/repo#42' });
      await mockPanel.simulateMessage({ type: 'watchPanelReady' });

      expect(getFocusWatchMessages(mockPanel)).toEqual([
        { type: 'focusWatch', watchId: 'pr:github-pr:owner/repo:42' },
      ]);
    });

    it('clears a pending focus target after one ready-time refresh attempt', async () => {
      const mockPanel = createMockWebviewPanel();
      vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
      const watcherService = createWatcherService([createPRWatch()]);
      const workGraph = createMockWorkGraph([{
        id: 'work-42',
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
        itemType: 'pr',
      }]);
      const provider = new WatchPanelProvider(
        vscode.Uri.file('C:\\repo') as any,
        watcherService as any,
        workGraph as any,
        createMockProviderRegistry() as any,
      );

      provider.open({ focusItemId: 'work-42' });
      await mockPanel.simulateMessage({ type: 'watchPanelReady' });
      expect(getFocusWatchMessages(mockPanel)).toHaveLength(1);

      // Trigger another refresh — the focus message must not fire again.
      workGraph.fireDidChange();
      expect(getFocusWatchMessages(mockPanel)).toHaveLength(1);
    });

    it('clears a buffered focus target when open() is called again without one', async () => {
      const mockPanel = createMockWebviewPanel();
      vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
      const watcherService = createWatcherService([createPRWatch()]);
      const workGraph = createMockWorkGraph([{
        id: 'work-42',
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
        itemType: 'pr',
      }]);
      const provider = new WatchPanelProvider(
        vscode.Uri.file('C:\\repo') as any,
        watcherService as any,
        workGraph as any,
        createMockProviderRegistry() as any,
      );

      // First open buffers a target while the webview is not ready.
      provider.open({ focusItemId: 'work-42' });
      expect(getFocusWatchMessages(mockPanel)).toEqual([]);

      // A subsequent untargeted open must drop the stale buffered target.
      provider.open();
      await mockPanel.simulateMessage({ type: 'watchPanelReady' });

      expect(getFocusWatchMessages(mockPanel)).toEqual([]);
    });

    it('falls back to matching by external id when the provider id does not match a duplicate surface', async () => {
      const mockPanel = createMockWebviewPanel();
      vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
      // The watch row is linked to a provider item from `github-my-prs`, but
      // the user clicks the CI badge on the duplicate surface in `github-pr-reviews`.
      const watcherService = createWatcherService([createPRWatch()]);
      const providerItems = new Map<string, any[]>([
        ['github-my-prs', [{ externalId: 'owner/repo#42', title: 'My PR', itemType: 'pr' }]],
      ]);
      const provider = new WatchPanelProvider(
        vscode.Uri.file('C:\\repo') as any,
        watcherService as any,
        createMockWorkGraph(),
        createMockProviderRegistry(providerItems) as any,
      );

      provider.open({
        focusProviderId: 'github-pr-reviews',
        focusExternalId: 'owner/repo#42',
      });
      await mockPanel.simulateMessage({ type: 'watchPanelReady' });

      expect(getFocusWatchMessages(mockPanel)).toEqual([
        { type: 'focusWatch', watchId: 'pr:github-pr:owner/repo:42' },
      ]);
    });
  });
});
