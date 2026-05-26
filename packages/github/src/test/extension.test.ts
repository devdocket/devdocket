import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { workspace, extensions, window } from 'vscode';
import { activate, deactivate } from '../extension';

const mockFetch = vi.fn();

describe('GitHub extension activation', () => {
  let mockContext: any;
  let mockApi: any;
  let disposables: any[];
  let providerRegistrationDisposables: any[];
  let runWatcherDisposables: any[];
  let prWatcherDisposable: any;
  let configChangeDisposable: any;
  let configChangeListener: ((event: { affectsConfiguration: (section: string) => boolean }) => void) | undefined;
  let refreshIntervalSeconds: number;

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
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);

    (window as any).createOutputChannel = vi.fn(() => ({
      appendLine: vi.fn(),
      append: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      name: 'DevDocket GitHub',
      replace: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      logLevel: 1,
      onDidChangeLogLevel: vi.fn(() => ({ dispose: vi.fn() })),
    }));

    disposables = [];
    providerRegistrationDisposables = [];
    runWatcherDisposables = [];
    prWatcherDisposable = { dispose: vi.fn() };
    configChangeDisposable = { dispose: vi.fn() };
    configChangeListener = undefined;
    refreshIntervalSeconds = 0;
    mockContext = {
      subscriptions: {
        push: (...items: any[]) => disposables.push(...items),
      },
    };

    mockApi = {
      registerProvider: vi.fn((provider: any) => {
        const registration = { registrationFor: provider.id, dispose: vi.fn() };
        providerRegistrationDisposables.push(registration);
        return registration;
      }),
      registerRunWatcher: vi.fn((watcher: any) => {
        const registration = { registrationFor: watcher.id, dispose: vi.fn() };
        runWatcherDisposables.push(registration);
        return registration;
      }),
      registerPRWatcher: vi.fn(() => prWatcherDisposable),
    };

    vi.mocked(extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: mockApi,
      activate: vi.fn(),
    } as any);

    vi.mocked(workspace.getConfiguration).mockImplementation((section?: string) => {
      if (section === 'devDocketGithub') {
        return {
          get: vi.fn((key: string, defaultValue?: any) => {
            if (key === 'refreshIntervalSeconds') return refreshIntervalSeconds;
            return defaultValue;
          }),
        } as any;
      }
      return {
        get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
      } as any;
    });
    vi.mocked(workspace.onDidChangeConfiguration).mockImplementation((listener: any) => {
      configChangeListener = listener;
      return configChangeDisposable;
    });
  });

  afterEach(() => {
    disposeContextSubscriptions();
    vi.unstubAllGlobals();
  });

  it('returns early when core extension is not found', async () => {
    vi.mocked(extensions.getExtension).mockReturnValue(undefined as any);

    await activate(mockContext);

    expect(mockApi.registerProvider).not.toHaveBeenCalled();
  });

  it('returns when core extension API is missing registerProvider', async () => {
    vi.mocked(extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: {},
      activate: vi.fn(),
    } as any);

    await activate(mockContext);

    expect(mockApi.registerProvider).not.toHaveBeenCalled();
  });

  it('pushes watcher registrations and configurable lifecycle owner onto subscriptions', async () => {
    await activate(mockContext);

    const providerIds = mockApi.registerProvider.mock.calls.map(([provider]: any[]) => provider.id);
    expect(providerIds).toEqual([
      'github',
      'github-pr-reviews',
      'github-my-prs',
      'github-mentions',
    ]);
    expect(mockApi.registerRunWatcher).toHaveBeenCalledTimes(2);
    const runWatcherIds = mockApi.registerRunWatcher.mock.calls.map(([watcher]: any[]) => watcher.id);
    expect(runWatcherIds).toEqual(['github-actions', 'github-advanced-security']);
    expect(mockApi.registerPRWatcher).toHaveBeenCalledTimes(1);

    for (const registration of runWatcherDisposables) {
      expect(disposables).toContain(registration);
    }
    expect(disposables).toContain(prWatcherDisposable);
    expect(disposables).toContain(configChangeDisposable);
    expect(disposables).toHaveLength(6);

    const lifecycleOwner = disposables.find(disposable =>
      disposable !== prWatcherDisposable &&
      disposable !== configChangeDisposable &&
      !runWatcherDisposables.includes(disposable) &&
      disposable?.dispose &&
      !('appendLine' in disposable),
    );
    expect(lifecycleOwner).toBeDefined();
  });

  it('waits for in-flight refresh aborts before updating GitHub refresh intervals', async () => {
    refreshIntervalSeconds = 120;
    await activate(mockContext);

    const providers = mockApi.registerProvider.mock.calls.map(([provider]: any[]) => provider);
    const startPeriodicRefreshSpies = providers.map((provider: any) => vi.spyOn(provider, 'startPeriodicRefresh'));
    expect(configChangeListener).toBeDefined();

    let resolveAbort!: () => void;
    const abortGate = new Promise<void>(resolve => {
      resolveAbort = resolve;
    });
    const firstAbortSpy = vi.spyOn(providers[0], 'abortInFlight').mockReturnValue(abortGate);

    refreshIntervalSeconds = 240;
    configChangeListener?.({
      affectsConfiguration: (section: string) => section === 'devDocketGithub.refreshIntervalSeconds',
    });

    await Promise.resolve();
    expect(firstAbortSpy).toHaveBeenCalledTimes(1);
    for (const spy of startPeriodicRefreshSpies) {
      expect(spy).not.toHaveBeenCalledWith(240);
    }
    expect(mockApi.registerProvider).toHaveBeenCalledTimes(4);

    resolveAbort();
    await vi.waitFor(() => {
      for (const spy of startPeriodicRefreshSpies) {
        expect(spy).toHaveBeenCalledWith(240);
      }
    });
    expect(mockApi.registerProvider).toHaveBeenCalledTimes(4);
  });

  it('updates GitHub refresh intervals even when aborting in-flight refreshes rejects', async () => {
    refreshIntervalSeconds = 120;
    await activate(mockContext);

    const providers = mockApi.registerProvider.mock.calls.map(([provider]: any[]) => provider);
    const startPeriodicRefreshSpies = providers.map((provider: any) => vi.spyOn(provider, 'startPeriodicRefresh'));
    vi.spyOn(providers[0], 'abortInFlight').mockRejectedValue(new Error('abort failed'));

    refreshIntervalSeconds = 240;
    configChangeListener?.({
      affectsConfiguration: (section: string) => section === 'devDocketGithub.refreshIntervalSeconds',
    });

    await vi.waitFor(() => {
      for (const spy of startPeriodicRefreshSpies) {
        expect(spy).toHaveBeenCalledWith(240);
      }
    });
    expect(mockApi.registerProvider).toHaveBeenCalledTimes(4);
  });

  it('lets context subscriptions dispose providers, registrations, and watchers', async () => {
    await activate(mockContext);

    const providers = mockApi.registerProvider.mock.calls.map(([provider]: any[]) => provider);
    const providerDisposeSpies = providers.map((provider: any) => vi.spyOn(provider, 'dispose'));

    disposeContextSubscriptions();

    for (const registration of providerRegistrationDisposables) {
      expect(registration.dispose).toHaveBeenCalledTimes(1);
    }
    for (const providerDisposeSpy of providerDisposeSpies) {
      expect(providerDisposeSpy).toHaveBeenCalledTimes(1);
    }
    for (const registration of runWatcherDisposables) {
      expect(registration.dispose).toHaveBeenCalledTimes(1);
    }
    expect(prWatcherDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(configChangeDisposable.dispose).toHaveBeenCalledTimes(1);
  });

  it('deactivate is a no-op', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
