import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { extensions, window } from 'vscode';
import { activate, deactivate } from '../extension';

describe('Start Git Work extension activation', () => {
  let mockContext: any;
  let mockApi: any;
  let disposables: any[];
  let actionDisposable: any;
  let transitionDisposable: any;

  const disposeContextSubscriptions = () => {
    const currentDisposables = disposables;
    disposables = [];
    for (const disposable of currentDisposables) {
      if (disposable && typeof disposable.dispose === 'function') {
        disposable.dispose();
      }
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();

    (window as any).createOutputChannel = vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      appendLine: vi.fn(),
      append: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      name: 'DevDocket Start Git Work',
      replace: vi.fn(),
      logLevel: 2,
      onDidChangeLogLevel: vi.fn(),
    }));

    disposables = [];
    actionDisposable = { dispose: vi.fn() };
    transitionDisposable = { dispose: vi.fn() };
    mockContext = {
      globalState: {
        get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
        update: vi.fn(),
      },
      subscriptions: {
        push: (...items: any[]) => disposables.push(...items),
      },
    };

    mockApi = {
      registerAction: vi.fn(() => actionDisposable),
      onDidTransitionState: vi.fn(() => transitionDisposable),
      addActivity: vi.fn(),
    };

    vi.mocked(extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: mockApi,
      activate: vi.fn(),
    } as any);
  });

  afterEach(() => {
    disposeContextSubscriptions();
  });

  it('pushes action and transition disposables onto subscriptions', async () => {
    await activate(mockContext);

    expect(mockApi.registerAction).toHaveBeenCalledTimes(1);
    expect(mockApi.onDidTransitionState).toHaveBeenCalledTimes(1);
    expect(disposables).toContain(actionDisposable);
    expect(disposables).toContain(transitionDisposable);
    expect(disposables.length).toBeGreaterThanOrEqual(2);
  });

  it('lets context subscriptions dispose registrations', async () => {
    await activate(mockContext);

    disposeContextSubscriptions();

    expect(actionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(transitionDisposable.dispose).toHaveBeenCalledTimes(1);
  });

  it('returns early when core extension is not found', async () => {
    vi.mocked(extensions.getExtension).mockReturnValue(undefined as any);

    await activate(mockContext);

    expect(mockApi.registerAction).not.toHaveBeenCalled();
  });

  it('deactivate is a no-op', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
