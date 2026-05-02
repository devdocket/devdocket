import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { MockMemento } from 'vscode';
import { activate, autoWatchAuthoredPRs, deactivate, logger } from '../extension';
import { MainViewProvider } from '../views/mainViewProvider';
import { WatchPanelProvider } from '../views/watchPanelProvider';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';

// Stub fs so migration never touches disk
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

function createExtensionContext(overrides?: Partial<vscode.ExtensionContext>): vscode.ExtensionContext {
  const subs: { dispose(): void }[] = [];
  return {
    subscriptions: subs,
    globalStorageUri: { fsPath: '/fake/storage' } as any,
    globalState: new MockMemento(),
    ...overrides,
  } as unknown as vscode.ExtensionContext;
}

/** Flush pending microtasks so coalesced UI updates execute. */
async function flushMicrotasks(): Promise<void> {
  // Await resolved promises to yield to the microtask queue.
  // Two rounds help nested microtasks scheduled by earlier microtasks settle too.
  await Promise.resolve();
  await Promise.resolve();
}

function getCommandHandler(commandId: string): (...args: any[]) => any {
  const registerCommand = vscode.commands.registerCommand as ReturnType<typeof vi.fn>;
  const registration = registerCommand.mock.calls.find((call: any[]) => call[0] === commandId);
  if (!registration) {
    throw new Error(`Command not registered: ${commandId}`);
  }
  return registration[1];
}

function getMainProvider(): MainViewProvider {
  const registerWebviewViewProvider = vscode.window.registerWebviewViewProvider as ReturnType<typeof vi.fn>;
  return registerWebviewViewProvider.mock.calls[0][1] as MainViewProvider;
}

describe('activate()', () => {
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createExtensionContext();
  });

  afterEach(() => {
    // Dispose everything activate pushed into subscriptions.
    // Surface disposal errors so cleanup bugs are caught.
    const errors: unknown[] = [];
    for (const sub of [...context.subscriptions].reverse()) {
      try { (sub as any).dispose?.(); } catch (e) { errors.push(e); }
    }
    if (errors.length > 0) {
      throw new Error(
        `Failed to dispose ${errors.length} subscription(s): ` +
        errors.map((e, i) => `[${i + 1}] ${e instanceof Error ? e.message : String(e)}`).join('; '),
      );
    }
  });

  // ------------------------------------------------------------------
  // 1. Returns a valid DevDocketApi
  // ------------------------------------------------------------------
  it('returns a DevDocketApi with registerProvider and registerAction', async () => {
    const api = await activate(context);
    expect(api).toBeDefined();
    expect(typeof api.registerProvider).toBe('function');
    expect(typeof api.registerAction).toBe('function');
  });

  // ------------------------------------------------------------------
  // 2. Registers expected disposables via specific API call counts
  // ------------------------------------------------------------------
  it('registers the expected configuration listener and output channel', async () => {
    await activate(context);

    const onDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration as ReturnType<typeof vi.fn>;
    expect(onDidChangeConfiguration).toHaveBeenCalled();

    expect(vscode.window.createOutputChannel).toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // 3. Registers the DevDocket webview provider
  // ------------------------------------------------------------------
  it('registers the DevDocket webview provider', async () => {
    await activate(context);
    expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
      'devdocket.main',
      expect.any(MainViewProvider),
      expect.objectContaining({ webviewOptions: { retainContextWhenHidden: true } }),
    );
  });

  // ------------------------------------------------------------------
  // 4. Registers commands
  // ------------------------------------------------------------------
  it('registers extension commands', async () => {
    await activate(context);
    const registerCommand = vscode.commands.registerCommand as ReturnType<typeof vi.fn>;
    expect(registerCommand).toHaveBeenCalled();
    const commandIds = registerCommand.mock.calls.map((c: any[]) => c[0]) as string[];
    expect(commandIds).toContain('devdocket.createItem');
    expect(commandIds).toContain('devdocket.acceptFromInbox');
  });

  // ------------------------------------------------------------------
  // 5. Creates an output channel
  // ------------------------------------------------------------------
  it('creates an output channel named DevDocket', async () => {
    await activate(context);
    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('DevDocket');
  });

  // ------------------------------------------------------------------
  // 6. Incoming status bar stays hidden when there are no items
  // ------------------------------------------------------------------
  it('hides the incoming status bar when there are no items', async () => {
    await activate(context);
    await flushMicrotasks();

    const createStatusBarItem = vscode.window.createStatusBarItem as ReturnType<typeof vi.fn>;
    const incomingStatusBar = createStatusBarItem.mock.results[1].value;
    expect(incomingStatusBar.command).toBe('devdocket.main.focus');
    expect(incomingStatusBar.hide).toHaveBeenCalled();
    expect(incomingStatusBar.show).not.toHaveBeenCalled();
  });

  it('updates the incoming status bar as provider items are discovered and dismissed', async () => {
    const api = await activate(context);
    const createStatusBarItem = vscode.window.createStatusBarItem as ReturnType<typeof vi.fn>;
    const incomingStatusBar = createStatusBarItem.mock.results[1].value;
    const dismissFromInbox = getCommandHandler('devdocket.dismissFromInbox');
    const itemEmitter = new (vscode.EventEmitter as any)();

    api.registerProvider({
      id: 'github',
      label: 'GitHub',
      onDidDiscoverItems: itemEmitter.event,
      refresh: vi.fn(async () => {
        itemEmitter.fire([
          { externalId: '1', title: 'Incoming issue', url: 'https://github.com/org/repo/issues/1' },
        ]);
      }),
    } as any);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(incomingStatusBar.text).toBe('⚡ 1 incoming');
    expect(incomingStatusBar.show).toHaveBeenCalled();

    await dismissFromInbox({ providerId: 'github', externalId: '1', title: 'Incoming issue' });
    await flushMicrotasks();

    expect(incomingStatusBar.hide).toHaveBeenCalled();
  });

  it('wires work graph, provider registry, and state store changes to DevDocket refresh', async () => {
    const api = await activate(context);
    const mainProvider = getMainProvider();
    const scheduleRefreshSpy = vi.spyOn(mainProvider, 'scheduleRefresh');
    vi.spyOn(WorkItemEditorPanel, 'open').mockImplementation(() => undefined);

    (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockResolvedValue('Created from command');
    await getCommandHandler('devdocket.createItem')();
    await flushMicrotasks();
    expect(scheduleRefreshSpy).toHaveBeenCalled();

    scheduleRefreshSpy.mockClear();
    const itemEmitter = new (vscode.EventEmitter as any)();
    api.registerProvider({
      id: 'provider-refresh',
      label: 'Provider Refresh',
      onDidDiscoverItems: itemEmitter.event,
      refresh: vi.fn(async () => {
        itemEmitter.fire([{ externalId: '2', title: 'Provider item', url: 'https://example.com/item/2' }]);
      }),
    } as any);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(scheduleRefreshSpy).toHaveBeenCalled();

    scheduleRefreshSpy.mockClear();
    await getCommandHandler('devdocket.dismissFromInbox')({ providerId: 'provider-refresh', externalId: '2', title: 'Provider item' });
    await flushMicrotasks();
    expect(scheduleRefreshSpy).toHaveBeenCalled();
  });

  it('creates a watch panel provider and opens it through the registered command', async () => {
    await activate(context);

    const watchPanelProvider = context.subscriptions.find(subscription => subscription instanceof WatchPanelProvider);
    expect(watchPanelProvider).toBeInstanceOf(WatchPanelProvider);

    const openSpy = vi.spyOn(watchPanelProvider as WatchPanelProvider, 'open').mockImplementation(() => undefined);
    await getCommandHandler('devdocket.showWatchesQuickPick')();

    expect(openSpy).toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // 7. Provider registration flow through the API
  // ------------------------------------------------------------------
  it('registerProvider delegates to ProviderRegistry and returns a disposable', async () => {
    const api = await activate(context);

    const itemEmitter = new (vscode.EventEmitter as any)();
    const provider = {
      id: 'test-provider',
      label: 'Test',
      onDidDiscoverItems: itemEmitter.event,
      refresh: vi.fn().mockResolvedValue(undefined),
    };

    const disposable = api.registerProvider(provider as any);
    expect(disposable).toBeDefined();
    expect(typeof disposable.dispose).toBe('function');

    // Provider's refresh should be called automatically during registration
    expect(provider.refresh).toHaveBeenCalled();

    // Dispose should not throw
    disposable.dispose();
  });

  // ------------------------------------------------------------------
  // 8. Action registration flow through the API
  // ------------------------------------------------------------------
  it('registerAction returns a disposable', async () => {
    const api = await activate(context);

    const action = {
      id: 'test-action',
      label: 'Test Action',
      canRun: vi.fn().mockReturnValue(true),
      run: vi.fn().mockResolvedValue(undefined),
    };

    const disposable = api.registerAction(action as any);
    expect(disposable).toBeDefined();
    expect(typeof disposable.dispose).toBe('function');
    disposable.dispose();
  });

  // ------------------------------------------------------------------
  // 9. Event coalescing: synchronous events during provider registration
  //    are coalesced into a single UI update via queueMicrotask
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 10. Auto-watch: authored PRs are watched on provider refresh
  // ------------------------------------------------------------------
  it('auto-watches authored PRs discovered on provider refresh', async () => {
    const providerRegistry = {
      getDiscoveredItems: vi.fn().mockReturnValue([
        {
          externalId: 'owner/repo#42',
          title: '#42: Authored PR',
          url: 'https://github.com/owner/repo/pull/42',
          authored: true,
        },
        {
          externalId: 'owner/repo#99',
          title: '#99: Assigned PR',
          url: 'https://github.com/owner/repo/pull/99',
        },
      ]),
    } as any;
    const identifier = {
      providerId: 'github-prs',
      prId: '42',
      displayName: 'PR #42',
      url: 'https://github.com/owner/repo/pull/42',
      repo: 'owner/repo',
    };
    const prWatcher = {
      parsePRUrl: vi.fn().mockReturnValue(identifier),
    };
    const prWatcherRegistry = {
      findWatcherForUrl: vi.fn((url: string) => url.includes('/pull/42') ? prWatcher : undefined),
    } as any;
    const watcherService = {
      isPRWatched: vi.fn().mockReturnValue(false),
      startPRWatch: vi.fn().mockResolvedValue(undefined),
    } as any;

    await autoWatchAuthoredPRs(
      'github-my-prs',
      providerRegistry,
      prWatcherRegistry,
      watcherService,
      new AbortController().signal,
    );

    expect(prWatcherRegistry.findWatcherForUrl).toHaveBeenCalledWith('https://github.com/owner/repo/pull/42');
    expect(prWatcher.parsePRUrl).toHaveBeenCalledWith('https://github.com/owner/repo/pull/42');
    expect(watcherService.isPRWatched).toHaveBeenCalledWith(identifier);
    expect(watcherService.startPRWatch).toHaveBeenCalledWith(identifier);
  });

  it('runs auto-watch and auto-complete in parallel after provider refresh', async () => {
    const globalState = context.globalState as InstanceType<typeof MockMemento>;
    const now = Date.now();
    await globalState.update('devdocket.workitems', [
      {
        id: 'auto-complete-item',
        title: 'Closed PR',
        state: 'New',
        providerId: 'github-my-prs',
        externalId: 'owner/repo#42',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await globalState.update('devdocket.migrated', true);

    const api = await activate(context);

    let resolveSnapshot: ((value: { prState: 'open'; runs: []; displayName?: string }) => void) | undefined;
    const snapshotPromise = new Promise<{ prState: 'open'; runs: []; displayName?: string }>((resolve) => {
      resolveSnapshot = resolve;
    });

    api.registerPRWatcher({
      id: 'github-prs',
      label: 'GitHub PRs',
      canWatch: (url: string) => url.includes('/pull/'),
      parsePRUrl: (url: string) => ({
        providerId: 'github-prs',
        prId: '42',
        displayName: 'PR #42',
        url,
        repo: 'owner/repo',
      }),
      getPRRunsSnapshot: vi.fn(() => snapshotPromise),
    } as any);

    const itemEmitter = new (vscode.EventEmitter as any)();
    const provider = {
      id: 'github-my-prs',
      label: 'My PRs',
      onDidDiscoverItems: itemEmitter.event,
      refresh: vi.fn(async () => {
        itemEmitter.fire([
          {
            externalId: 'owner/repo#42',
            title: 'Closed PR',
            url: 'https://github.com/owner/repo/pull/42',
            authored: true,
          },
        ]);
      }),
      getClosedItems: vi.fn(async (externalIds: string[]) => externalIds.filter(id => id === 'owner/repo#42')),
    };

    api.registerProvider(provider as any);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(provider.getClosedItems).toHaveBeenCalledWith(['owner/repo#42'], expect.any(AbortSignal));

    resolveSnapshot?.({ prState: 'open', runs: [] });
    await flushMicrotasks();
  });

  it('does not recreate auto-watched PRs on later refreshes', async () => {
    const providerRegistry = {
      getDiscoveredItems: vi.fn().mockReturnValue([
        {
          externalId: 'owner/repo#42',
          title: '#42: Authored PR',
          url: 'https://github.com/owner/repo/pull/42',
          authored: true,
        },
      ]),
    } as any;
    const identifier = {
      providerId: 'github-prs',
      prId: '42',
      displayName: 'PR #42',
      url: 'https://github.com/owner/repo/pull/42',
      repo: 'owner/repo',
    };
    const prWatcher = {
      parsePRUrl: vi.fn().mockReturnValue(identifier),
    };
    const prWatcherRegistry = {
      findWatcherForUrl: vi.fn().mockReturnValue(prWatcher),
    } as any;
    const watcherService = {
      isPRWatched: vi.fn().mockReturnValue(true),
      startPRWatch: vi.fn().mockResolvedValue(undefined),
    } as any;

    await autoWatchAuthoredPRs(
      'github-my-prs',
      providerRegistry,
      prWatcherRegistry,
      watcherService,
      new AbortController().signal,
    );

    expect(prWatcher.parsePRUrl).toHaveBeenCalledTimes(1);
    expect(watcherService.startPRWatch).not.toHaveBeenCalled();
  });

  it('logs auto-watch failures with URL context and error details', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const providerRegistry = {
      getDiscoveredItems: vi.fn().mockReturnValue([
        {
          externalId: 'owner/repo#42',
          title: '#42: Authored PR',
          url: 'https://github.com/owner/repo/pull/42',
          authored: true,
        },
      ]),
    } as any;
    const identifier = {
      providerId: 'github-prs',
      prId: '42',
      displayName: 'PR #42',
      url: 'https://github.com/owner/repo/pull/42',
      repo: 'owner/repo',
    };
    const prWatcherRegistry = {
      findWatcherForUrl: vi.fn().mockReturnValue({
        parsePRUrl: vi.fn().mockReturnValue(identifier),
      }),
    } as any;
    const error = new Error('boom');
    const watcherService = {
      isPRWatched: vi.fn().mockReturnValue(false),
      startPRWatch: vi.fn().mockRejectedValue(error),
    } as any;

    await autoWatchAuthoredPRs(
      'github-my-prs',
      providerRegistry,
      prWatcherRegistry,
      watcherService,
      new AbortController().signal,
    );

    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to auto-watch authored PR from provider github-my-prs',
      { url: 'https://github.com/owner/repo/pull/42' },
      error,
    );
  });

  // ------------------------------------------------------------------
  // 11. State migration: provider-backed items without inbox state get accepted
  // ------------------------------------------------------------------
  it('migrates provider-backed work items to accepted state', async () => {
    // Seed the store with a work item that has provider info via globalState
    const globalState = context.globalState as InstanceType<typeof MockMemento>;
    const workItems = [
      {
        id: 'migr-1',
        title: 'Migrated Item',
        state: 'New',
        providerId: 'gh',
        externalId: 'ext-99',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    // Pre-populate globalState so stores load the work item
    await globalState.update('devdocket.workitems', workItems);
    // Mark migration as done so migrateToGlobalState is skipped
    await globalState.update('devdocket.migrated', true);

    await activate(context);

    // The discovered state should contain the accepted state in globalState
    const discoveredState = globalState.get<unknown[]>('devdocket.discovered-state');
    expect(discoveredState).toBeDefined();
    const acceptedRecord = (discoveredState as any[]).find(
      (r: any) => r.providerId === 'gh' && r.externalId === 'ext-99' && r.inboxState === 'accepted',
    );
    expect(acceptedRecord).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 11. Error handling: activate succeeds even with no storage files
  // ------------------------------------------------------------------
  it('activates successfully when storage files do not exist (ENOENT)', async () => {
    // Default mock already returns ENOENT — just verify no throw
    const api = await activate(context);
    expect(api).toBeDefined();
    expect(typeof api.registerProvider).toBe('function');
  });

  // ------------------------------------------------------------------
  // 12. Error handling: corrupt workitems.json
  // ------------------------------------------------------------------
  it('recovers gracefully when workitems.json contains invalid JSON', async () => {
    const fs = await import('fs/promises');
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce('NOT VALID JSON');
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ size: 100, isFile: () => true }); // workitems.json stat

    await expect(activate(context)).resolves.toBeDefined();
  });

  // ------------------------------------------------------------------
  // 13. Log level configuration is read on activation
  // ------------------------------------------------------------------
  it('reads devDocket.logLevel configuration', async () => {
    await activate(context);
    expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('devDocket');
  });

  // ------------------------------------------------------------------
  // 14. Sets view messages for empty state
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 15. Error handling: safeHandler catches sync throw in event callback
  // ------------------------------------------------------------------
  it('logs error and continues when a safeHandler-wrapped callback throws', async () => {
    await activate(context);
    await flushMicrotasks();

    const errorSpy = vi.spyOn(logger, 'error');

    // The onDidChangeConfiguration listener is wrapped with safeHandler.
    // Force its inner code to throw by making getConfiguration throw.
    const onDidChangeCfg = vscode.workspace.onDidChangeConfiguration as ReturnType<typeof vi.fn>;
    const configListener = onDidChangeCfg.mock.calls[0][0];

    (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => { throw new Error('Config read failure'); });

    // Call the safeHandler-wrapped listener — should not throw
    configListener({ affectsConfiguration: () => true });
    await flushMicrotasks();

    // Verify the error was logged via safeHandler's catch
    expect(errorSpy).toHaveBeenCalledWith(
      'Error handling configuration change',
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  // ------------------------------------------------------------------
  // 16. Error handling: microtask catches view setter errors and
  //     continues processing subsequent UI updates
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 17. Error handling: safeHandler catches sync throws via promise chain
  // ------------------------------------------------------------------
  it('catches sync throws via promise chain without unhandled rejections', async () => {
    const api = await activate(context);
    await flushMicrotasks();

    const errorSpy = vi.spyOn(logger, 'error');
    const onUnhandledRejection = vi.fn();
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // The onDidChangeConfiguration listener is wrapped with safeHandler
      // which runs callbacks via Promise.resolve().then().catch(). A sync
      // throw inside .then() becomes a rejected promise caught by .catch().
      const onDidChangeCfg = vscode.workspace.onDidChangeConfiguration as ReturnType<typeof vi.fn>;
      const configListener = onDidChangeCfg.mock.calls[0][0];

      // Make the wrapped function throw synchronously — safeHandler's
      // promise chain converts this to a caught rejection.
      (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => { throw new Error('Config failure'); });

      configListener({ affectsConfiguration: () => true });
      await flushMicrotasks();

      // Error should have been caught by safeHandler, not surfaced as unhandled
      expect(errorSpy).toHaveBeenCalledWith(
        'Error handling configuration change',
        expect.any(Error),
      );
      expect(onUnhandledRejection).not.toHaveBeenCalled();

      // Extension should still be functional — register a provider
      const provider = {
        id: 'err-async-ok',
        label: 'ErrAsyncOk',
        onDidDiscoverItems: new (vscode.EventEmitter as any)().event,
        refresh: vi.fn().mockResolvedValue(undefined),
      };
      expect(() => api.registerProvider(provider as any)).not.toThrow();
      await flushMicrotasks();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      errorSpy.mockRestore();
    }
  });

  // ------------------------------------------------------------------
  // 18. Sets context keys for all five view layouts on activation
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 18b. Context key values match view defaults on activation
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 19. Layout change updates provider layouts and context keys
  // ------------------------------------------------------------------
});

describe('deactivate()', () => {
  it('does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('is a synchronous void function', () => {
    const result = deactivate();
    expect(result).toBeUndefined();
  });
});
