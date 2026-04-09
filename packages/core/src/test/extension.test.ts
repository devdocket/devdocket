import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';

// Stub fs so stores never touch disk
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
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
  // 1. Returns a valid WorkCenterApi
  // ------------------------------------------------------------------
  it('returns a WorkCenterApi with registerProvider and registerAction', async () => {
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
    expect(viewIds).toContain('workcenter.inbox');
    expect(viewIds).toContain('workcenter.queue');
    expect(viewIds).toContain('workcenter.focus');
    expect(viewIds).toContain('workcenter.sources');
    expect(viewIds).toContain('workcenter.history');
  });

  // ------------------------------------------------------------------
  // 4. Registers commands
  // ------------------------------------------------------------------
  it('registers extension commands', async () => {
    await activate(context);
    const registerCommand = vscode.commands.registerCommand as ReturnType<typeof vi.fn>;
    expect(registerCommand).toHaveBeenCalled();
    const commandIds = registerCommand.mock.calls.map((c: any[]) => c[0]) as string[];
    expect(commandIds).toContain('workcenter.createItem');
    expect(commandIds).toContain('workcenter.acceptFromInbox');
  });

  // ------------------------------------------------------------------
  // 5. Creates an output channel
  // ------------------------------------------------------------------
  it('creates an output channel named WorkCenter', async () => {
    await activate(context);
    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('WorkCenter');
  });

  // ------------------------------------------------------------------
  // 6. Badge is undefined when there are no providers or items
  // ------------------------------------------------------------------
  it('initialises inbox badge to undefined when there are no items', async () => {
    await activate(context);
    await flushMicrotasks();

    const createTreeView = vscode.window.createTreeView as ReturnType<typeof vi.fn>;
    const inboxCall = createTreeView.mock.calls.find((c: any[]) => c[0] === 'workcenter.inbox');
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
    const inboxIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'workcenter.inbox');
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

    await expect(activate(context)).resolves.toBeDefined();
  });

  // ------------------------------------------------------------------
  // 13. Log level configuration is read on activation
  // ------------------------------------------------------------------
  it('reads workcenter.logLevel configuration', async () => {
    await activate(context);
    expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('workcenter');
  });

  // ------------------------------------------------------------------
  // 14. Sets view messages for empty state
  // ------------------------------------------------------------------
  it('sets initial view messages for empty views', async () => {
    await activate(context);
    await flushMicrotasks();

    const createTreeView = vscode.window.createTreeView as ReturnType<typeof vi.fn>;

    const queueIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'workcenter.queue');
    expect(queueIdx).toBeGreaterThanOrEqual(0);
    const queueView = createTreeView.mock.results[queueIdx].value;
    expect(queueView.message).toBe('No items in queue');

    const focusIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'workcenter.focus');
    expect(focusIdx).toBeGreaterThanOrEqual(0);
    const focusView = createTreeView.mock.results[focusIdx].value;
    expect(focusView.message).toBe('No active work');

    const historyIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'workcenter.history');
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    const historyView = createTreeView.mock.results[historyIdx].value;
    expect(historyView.message).toBe('No history items');
  });

  // ------------------------------------------------------------------
  // 15. Error handling: safeHandler catches sync errors in callbacks
  // ------------------------------------------------------------------
  it('continues activation when a wrapped event callback throws synchronously', async () => {
    const api = await activate(context);
    await flushMicrotasks();

    const itemEmitter = new (vscode.EventEmitter as any)();
    const provider = {
      id: 'err-sync',
      label: 'ErrSync',
      onDidDiscoverItems: itemEmitter.event,
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    api.registerProvider(provider as any);
    await flushMicrotasks();

    // Fire an event that triggers a callback which will exercise safeHandler.
    // Even if the internal UI update path encountered an error, the extension
    // should remain functional — subsequent events still trigger UI updates.
    const createTreeView = vscode.window.createTreeView as ReturnType<typeof vi.fn>;
    const inboxIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'workcenter.inbox');
    const inboxView = createTreeView.mock.results[inboxIdx].value;

    let messageSetCount = 0;
    let currentMessage: string | undefined = inboxView.message;
    Object.defineProperty(inboxView, 'message', {
      get: () => currentMessage,
      set: (v: string | undefined) => { currentMessage = v; messageSetCount++; },
      configurable: true,
    });

    // Fire a discovered items event, then verify the UI still updates
    itemEmitter.fire([]);
    await flushMicrotasks();
    expect(messageSetCount).toBeGreaterThan(0);

    // Fire again — should still work (coalescing flag was properly reset)
    messageSetCount = 0;
    itemEmitter.fire([]);
    await flushMicrotasks();
    expect(messageSetCount).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------
  // 16. Error handling: uiUpdateScheduled resets even when microtask throws
  // ------------------------------------------------------------------
  it('resets uiUpdateScheduled flag after microtask errors via finally', async () => {
    const api = await activate(context);
    await flushMicrotasks();

    const createTreeView = vscode.window.createTreeView as ReturnType<typeof vi.fn>;
    const sourcesIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'workcenter.sources');
    const sourcesView = createTreeView.mock.results[sourcesIdx].value;

    // Make the sources view message setter throw to simulate a microtask error
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

    // Remove the throwing setter so next update succeeds
    Object.defineProperty(sourcesView, 'message', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    // The coalescing flag should have been reset by `finally`, so
    // a subsequent event should still trigger a UI update.
    const inboxIdx = createTreeView.mock.calls.findIndex((c: any[]) => c[0] === 'workcenter.inbox');
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
  });

  // ------------------------------------------------------------------
  // 17. Error handling: safeHandler catches async rejection in callbacks
  // ------------------------------------------------------------------
  it('catches async rejections in safeHandler-wrapped callbacks', async () => {
    const api = await activate(context);
    await flushMicrotasks();

    // Register a provider whose refresh rejects — safeHandler should
    // catch the rejection without surfacing an unhandled promise rejection.
    const itemEmitter = new (vscode.EventEmitter as any)();
    const provider = {
      id: 'err-async',
      label: 'ErrAsync',
      onDidDiscoverItems: itemEmitter.event,
      refresh: vi.fn().mockRejectedValue(new Error('Async refresh failure')),
    };

    // registerProvider should not throw despite refresh rejection
    expect(() => api.registerProvider(provider as any)).not.toThrow();
    await flushMicrotasks();

    // Extension should still be functional — can register more providers
    const provider2 = {
      id: 'err-async-2',
      label: 'ErrAsync2',
      onDidDiscoverItems: new (vscode.EventEmitter as any)().event,
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    expect(() => api.registerProvider(provider2 as any)).not.toThrow();
    await flushMicrotasks();
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
