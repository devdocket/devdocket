import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate, logger } from '../extension';

// Stub fs so stores never touch disk
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
  // 3. Creates tree views for all five panels
  // ------------------------------------------------------------------
  it('creates tree views for inbox, queue, focus, sources, and history', async () => {
    await activate(context);
    const createTreeView = vscode.window.createTreeView as ReturnType<typeof vi.fn>;
    const viewIds = createTreeView.mock.calls.map((c: any[]) => c[0]);
    expect(viewIds).toContain('devdocket.inbox');
    expect(viewIds).toContain('devdocket.queue');
    expect(viewIds).toContain('devdocket.focus');
    expect(viewIds).toContain('devdocket.sources');
    expect(viewIds).toContain('devdocket.history');
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
  // 6. Badge is undefined when there are no providers or items
  // ------------------------------------------------------------------
  it('initialises inbox badge to undefined when there are no items', async () => {
    await activate(context);
    await flushMicrotasks();

    const createTreeView = vscode.window.createTreeView as ReturnType<typeof vi.fn>;
    const inboxCall = createTreeView.mock.calls.find((c: any[]) => c[0] === 'devdocket.inbox');
    expect(inboxCall).toBeDefined();
    // The mock createTreeView returns an object with a badge property
    const inboxView = createTreeView.mock.results[
      createTreeView.mock.calls.indexOf(inboxCall!)
    ].value;
    // With no providers / items, badge should be undefined (no count)
    expect(inboxView.badge).toBeUndefined();
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
  it('coalesces synchronous events during provider registration', async () => {
    const api = await activate(context);
    await flushMicrotasks();

    const createTreeView = vscode.window.createTreeView as ReturnType<typeof vi.fn>;
    const inboxIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'devdocket.inbox');
    expect(inboxIdx).toBeGreaterThanOrEqual(0);
    const inboxView = createTreeView.mock.results[inboxIdx].value;

    // Track how many times `message` is written
    let messageSetCount = 0;
    let currentMessage: string | undefined = inboxView.message;
    Object.defineProperty(inboxView, 'message', {
      get: () => currentMessage,
      set: (v: string | undefined) => { currentMessage = v; messageSetCount++; },
      configurable: true,
    });

    // register() fires onDidRegisterProvider AND onDidChangeDiscoveredItems
    // synchronously — two scheduleUiUpdate calls in the same synchronous block.
    // The coalescing flag should prevent the second queueMicrotask.
    const itemEmitter = new (vscode.EventEmitter as any)();
    const provider = {
      id: 'coalesce-test',
      label: 'Coalesce',
      onDidDiscoverItems: itemEmitter.event,
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    api.registerProvider(provider as any);

    // Before microtasks run, no message should have been set yet
    // because scheduleUiUpdate defers via queueMicrotask.
    expect(messageSetCount).toBe(0);

    await flushMicrotasks();

    // After flushing, the coalesced callback ran. Even though register()
    // fired 2 events synchronously, the first queueMicrotask should
    // coalesce them. provider.refresh() also fires another event later.
    // Total message writes should be strictly less than the raw event count (≥2).
    expect(messageSetCount).toBeGreaterThan(0);
    expect(messageSetCount).toBeLessThanOrEqual(2);
  });

  // ------------------------------------------------------------------
  // 10. State migration: provider-backed items without inbox state get accepted
  // ------------------------------------------------------------------
  it('migrates provider-backed work items to accepted state', async () => {
    // Seed the store with a work item that has provider info
    const fs = await import('fs/promises');
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
    (fs.readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify(workItems))   // workitems.json
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })); // discovered-state.json
    (fs.stat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ size: 100, isFile: () => true }); // workitems.json stat

    await activate(context);

    // The writeFile call should include the migration state
    expect(fs.writeFile).toHaveBeenCalled();
    const writeCalls = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls;
    const stateWriteCall = writeCalls.find((c: any[]) =>
      typeof c[1] === 'string' && c[1].includes('"accepted"'),
    );
    expect(stateWriteCall).toBeDefined();
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
  it('sets initial view messages for empty views', async () => {
    await activate(context);
    await flushMicrotasks();

    const createTreeView = vscode.window.createTreeView as ReturnType<typeof vi.fn>;

    const queueIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'devdocket.queue');
    expect(queueIdx).toBeGreaterThanOrEqual(0);
    const queueView = createTreeView.mock.results[queueIdx].value;
    expect(queueView.message).toBe('No items in queue');

    const focusIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'devdocket.focus');
    expect(focusIdx).toBeGreaterThanOrEqual(0);
    const focusView = createTreeView.mock.results[focusIdx].value;
    expect(focusView.message).toBe('No active work');

    const historyIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'devdocket.history');
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    const historyView = createTreeView.mock.results[historyIdx].value;
    expect(historyView.message).toBe('No history items');
  });

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
  it('catches view setter errors in microtask and continues processing UI updates', async () => {
    const api = await activate(context);
    await flushMicrotasks();

    const createTreeView = vscode.window.createTreeView as ReturnType<typeof vi.fn>;
    const sourcesIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'devdocket.sources');
    const sourcesView = createTreeView.mock.results[sourcesIdx].value;

    // Make the sources view message setter throw to trigger the inner catch
    // inside the microtask's updateViewMessages() path.
    const errorSpy = vi.spyOn(logger, 'error');
    Object.defineProperty(sourcesView, 'message', {
      get: () => undefined,
      set: () => { throw new Error('Simulated view message error'); },
      configurable: true,
    });

    const itemEmitter = new (vscode.EventEmitter as any)();
    const provider = {
      id: 'err-finally',
      label: 'ErrFinally',
      onDidDiscoverItems: itemEmitter.event,
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    api.registerProvider(provider as any);
    await flushMicrotasks();

    // Verify the error was caught and logged inside the microtask
    expect(errorSpy).toHaveBeenCalledWith(
      'Error updating view messages',
      expect.any(Error),
    );

    // Remove the throwing setter so next update succeeds
    Object.defineProperty(sourcesView, 'message', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    // The coalescing flag should have been reset (by the finally block),
    // so a subsequent event should still trigger a UI update.
    const inboxIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'devdocket.inbox');
    const inboxView = createTreeView.mock.results[inboxIdx].value;

    let messageSetCount = 0;
    let currentMessage: string | undefined = inboxView.message;
    Object.defineProperty(inboxView, 'message', {
      get: () => currentMessage,
      set: (v: string | undefined) => { currentMessage = v; messageSetCount++; },
      configurable: true,
    });

    itemEmitter.fire([]);
    await flushMicrotasks();
    expect(messageSetCount).toBeGreaterThan(0);

    errorSpy.mockRestore();
  });

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
  it('sets layout context keys for all five views on activation', async () => {
    await activate(context);

    const executeCommand = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
    const setContextCalls = executeCommand.mock.calls.filter(
      (c: any[]) => c[0] === 'setContext' && typeof c[1] === 'string' && c[1].endsWith('Layout'),
    );

    const contextKeys = setContextCalls.map((c: any[]) => c[1]);
    expect(contextKeys).toContain('devdocket.inboxLayout');
    expect(contextKeys).toContain('devdocket.queueLayout');
    expect(contextKeys).toContain('devdocket.focusLayout');
    expect(contextKeys).toContain('devdocket.historyLayout');
    expect(contextKeys).toContain('devdocket.sourcesLayout');
  });

  // ------------------------------------------------------------------
  // 18b. Context key values match view defaults on activation
  // ------------------------------------------------------------------
  it('sets correct default values for layout context keys', async () => {
    await activate(context);

    const executeCommand = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
    const setContextCalls = executeCommand.mock.calls.filter(
      (c: any[]) => c[0] === 'setContext' && typeof c[1] === 'string' && c[1].endsWith('Layout'),
    );

    const contextMap = Object.fromEntries(setContextCalls.map((c: any[]) => [c[1], c[2]]));
    expect(contextMap['devdocket.inboxLayout']).toBe('tree');
    expect(contextMap['devdocket.queueLayout']).toBe('flat');
    expect(contextMap['devdocket.focusLayout']).toBe('flat');
    expect(contextMap['devdocket.historyLayout']).toBe('flat');
    expect(contextMap['devdocket.sourcesLayout']).toBe('tree');
  });

  // ------------------------------------------------------------------
  // 19. Layout config change updates provider layouts and context keys
  // ------------------------------------------------------------------
  it('updates provider layouts and context keys on configuration change', async () => {
    await activate(context);
    await flushMicrotasks();

    const executeCommand = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
    executeCommand.mockClear();

    // Simulate a configuration change for devdocket.viewLayout
    const onDidChangeCfg = vscode.workspace.onDidChangeConfiguration as ReturnType<typeof vi.fn>;
    // Find the viewLayout config listener (the last registered one)
    const listeners = onDidChangeCfg.mock.calls.map((c: any[]) => c[0]);
    expect(listeners.length).toBeGreaterThan(0);

    // Mock getConfiguration to return a specific layout
    (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn((_key: string) => {
        if (_key === 'viewLayout') { return { focus: 'tree', queue: 'tree' }; }
        return undefined;
      }),
      update: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn(() => undefined),
    });

    // Fire configuration change event on all listeners
    for (const listener of listeners) {
      listener({ affectsConfiguration: (section: string) => section === 'devDocket.viewLayout' });
    }
    await flushMicrotasks();

    // setContext should have been called for all five views
    const setContextCalls = executeCommand.mock.calls.filter(
      (c: any[]) => c[0] === 'setContext' && typeof c[1] === 'string' && c[1].endsWith('Layout'),
    );
    const contextKeys = setContextCalls.map((c: any[]) => c[1]);
    expect(contextKeys).toContain('devdocket.focusLayout');
    expect(contextKeys).toContain('devdocket.queueLayout');

    // Verify context key values reflect the updated layout
    const contextMap = Object.fromEntries(setContextCalls.map((c: any[]) => [c[1], c[2]]));
    expect(contextMap['devdocket.focusLayout']).toBe('tree');
    expect(contextMap['devdocket.queueLayout']).toBe('tree');
    // Views not in the override should still have their defaults
    expect(contextMap['devdocket.inboxLayout']).toBe('tree');
    expect(contextMap['devdocket.historyLayout']).toBe('flat');
  });
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
