import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { MockMemento } from 'vscode';
import { activate, autoWatchAuthoredPRs, deactivate, logger } from '../extension';
import { ReadStateStore } from '../storage/readStateStore';
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

  it('prunes stale read-state and discovered-state records after non-empty provider refresh', async () => {
    const globalState = context.globalState as InstanceType<typeof MockMemento>;
    await globalState.update('devdocket.migrated', true);
    await globalState.update('devdocket.discovered-state', [
      { providerId: 'prune-provider', externalId: 'keep', inboxState: 'accepted' },
      { providerId: 'prune-provider', externalId: 'stale', inboxState: 'dismissed' },
      { providerId: 'other-provider', externalId: 'stale', inboxState: 'accepted' },
    ]);
    await globalState.update('devdocket.read-state', [
      'prune-provider::keep',
      'prune-provider::stale',
      'other-provider::stale',
    ]);
    const pruneSpy = vi.spyOn(ReadStateStore.prototype, 'prune');

    try {
      const api = await activate(context);
      const itemEmitter = new (vscode.EventEmitter as any)();
      const activeItem = { externalId: 'keep', title: 'Keep' };

      api.registerProvider({
        id: 'prune-provider',
        label: 'Prune Provider',
        onDidDiscoverItems: itemEmitter.event,
        refresh: vi.fn(async () => {
          itemEmitter.fire([activeItem]);
        }),
      } as any);

      await vi.waitFor(() => {
        expect(pruneSpy).toHaveBeenCalled();
        expect(globalState.get<string[]>('devdocket.read-state')).toEqual([
          'prune-provider::keep',
          'other-provider::stale',
        ]);
      });

      const active = pruneSpy.mock.calls.at(-1)?.[0] as Map<string, unknown[]>;
      expect(active.get('prune-provider')).toEqual([activeItem]);

      const discoveredRecords = globalState.get<Array<{ providerId: string; externalId: string }>>('devdocket.discovered-state') ?? [];
      expect(discoveredRecords.map(record => `${record.providerId}::${record.externalId}`).sort()).toEqual([
        'other-provider::stale',
        'prune-provider::keep',
      ]);
    } finally {
      pruneSpy.mockRestore();
    }
  });

  it('leaves read-state and discovered-state records untouched after empty provider refresh', async () => {
    const globalState = context.globalState as InstanceType<typeof MockMemento>;
    await globalState.update('devdocket.migrated', true);
    await globalState.update('devdocket.discovered-state', [
      { providerId: 'empty-provider', externalId: 'stale', inboxState: 'accepted' },
    ]);
    await globalState.update('devdocket.read-state', ['empty-provider::stale']);
    const pruneSpy = vi.spyOn(ReadStateStore.prototype, 'prune');

    try {
      const api = await activate(context);
      const itemEmitter = new (vscode.EventEmitter as any)();

      api.registerProvider({
        id: 'empty-provider',
        label: 'Empty Provider',
        onDidDiscoverItems: itemEmitter.event,
        refresh: vi.fn(async () => {
          itemEmitter.fire([]);
        }),
      } as any);

      await vi.waitFor(() => expect(pruneSpy).toHaveBeenCalled());

      const active = pruneSpy.mock.calls.at(-1)?.[0] as Map<string, unknown[]>;
      expect(active.get('empty-provider')).toEqual([]);
      expect(globalState.get<string[]>('devdocket.read-state')).toEqual(['empty-provider::stale']);
      expect(globalState.get<Array<{ providerId: string; externalId: string }>>('devdocket.discovered-state')).toEqual([
        { providerId: 'empty-provider', externalId: 'stale', inboxState: 'accepted' },
      ]);
    } finally {
      pruneSpy.mockRestore();
    }
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

  it('refuses to auto-watch authored items whose url is not http(s)', async () => {
    // Defense-in-depth: a malicious provider can claim authored:true with
    // any URL string. Reject anything that wouldn't survive isSafeUrl.
    const providerRegistry = {
      getDiscoveredItems: vi.fn().mockReturnValue([
        { externalId: 'a', title: 'js', url: 'javascript:alert(1)', authored: true },
        { externalId: 'b', title: 'data', url: 'data:text/html,<script>alert(1)</script>', authored: true },
        { externalId: 'c', title: 'file', url: 'file:///etc/passwd', authored: true },
        { externalId: 'd', title: 'good', url: 'https://github.com/owner/repo/pull/42', authored: true },
      ]),
    } as any;
    const goodIdentifier = { providerId: 'github-prs', prId: '42', displayName: 'PR #42', url: 'https://github.com/owner/repo/pull/42', repo: 'owner/repo' };
    const prWatcher = { parsePRUrl: vi.fn().mockReturnValue(goodIdentifier) };
    const prWatcherRegistry = {
      findWatcherForUrl: vi.fn((url: string) => url.startsWith('https://') ? prWatcher : undefined),
    } as any;
    const watcherService = {
      isPRWatched: vi.fn().mockResolvedValue(false),
      startPRWatch: vi.fn().mockResolvedValue(undefined),
    } as any;

    await autoWatchAuthoredPRs(
      'github-my-prs',
      providerRegistry,
      prWatcherRegistry,
      watcherService,
      new AbortController().signal,
    );

    // Only the https URL should reach findWatcherForUrl; the malicious
    // schemes are short-circuited before any provider-specific parsing.
    expect(prWatcherRegistry.findWatcherForUrl).toHaveBeenCalledTimes(1);
    expect(prWatcherRegistry.findWatcherForUrl).toHaveBeenCalledWith('https://github.com/owner/repo/pull/42');
    expect(watcherService.startPRWatch).toHaveBeenCalledTimes(1);
    expect(watcherService.startPRWatch).toHaveBeenCalledWith(goodIdentifier);
  });

  it('caps the number of authored PRs auto-watched per provider per pass', async () => {
    // Hostile/buggy provider could otherwise spawn an unbounded number of
    // polling timers (one per authored item). The cap keeps polling cost
    // bounded and surfaces a warning so the issue is observable.
    const items = Array.from({ length: 250 }, (_, i) => ({
      externalId: `owner/repo#${i}`,
      title: `PR ${i}`,
      url: `https://github.com/owner/repo/pull/${i}`,
      authored: true,
    }));
    const providerRegistry = { getDiscoveredItems: vi.fn().mockReturnValue(items) } as any;
    const prWatcher = {
      parsePRUrl: vi.fn((url: string) => ({ providerId: 'github-prs', prId: url, displayName: url, url, repo: 'owner/repo' })),
    };
    const prWatcherRegistry = { findWatcherForUrl: vi.fn(() => prWatcher) } as any;
    const watcherService = {
      isPRWatched: vi.fn().mockResolvedValue(false),
      startPRWatch: vi.fn().mockResolvedValue(undefined),
    } as any;

    await autoWatchAuthoredPRs(
      'github-my-prs',
      providerRegistry,
      prWatcherRegistry,
      watcherService,
      new AbortController().signal,
    );

    // Cap is 200 per provider per refresh pass.
    expect(watcherService.startPRWatch).toHaveBeenCalledTimes(200);
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
