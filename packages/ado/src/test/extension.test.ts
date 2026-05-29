import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { workspace, extensions, window, commands } from 'vscode';
import { activate, deactivate } from '../extension';

// Stub fetch globally to prevent real network calls from provider.refresh()
const mockFetch = vi.fn();

describe('extension activation', () => {
  let mockContext: any;
  let mockApi: any;
  let disposables: any[];
  let providerRegistrationDisposables: any[];
  let runWatcherDisposable: any;
  let prWatcherDisposable: any;

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
    (workspace as any).workspaceFolders = [{ uri: { fsPath: '/mock/workspace' } }];

    (window as any).createOutputChannel = vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      appendLine: vi.fn(),
      dispose: vi.fn(),
    }));

    disposables = [];
    providerRegistrationDisposables = [];
    runWatcherDisposable = { dispose: vi.fn() };
    prWatcherDisposable = { dispose: vi.fn() };
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
      registerRunWatcher: vi.fn(() => runWatcherDisposable),
      registerPRWatcher: vi.fn(() => prWatcherDisposable),
    };

    // Default: core extension found and active with valid API
    vi.mocked(extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: mockApi,
      activate: vi.fn(),
    } as any);

    // Default: organization configured
    vi.mocked(workspace.getConfiguration).mockImplementation((section?: string) => {
      if (section === 'devDocketAdo') {
        return {
          get: vi.fn((key: string, defaultValue?: any) => {
            if (key === 'organization') return 'myorg';
            if (key === 'projects') return ['ProjectA'];
            if (key === 'refreshIntervalSeconds') return 0;
            return defaultValue;
          }),
        } as any;
      }
      return {
        get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
      } as any;
    });
  });

  afterEach(() => {
    disposeContextSubscriptions();
    vi.unstubAllGlobals();
  });

  it('activates fully when no workspace folder is open', async () => {
    (workspace as any).workspaceFolders = [];

    await activate(mockContext);

    expect(window.createOutputChannel).toHaveBeenCalled();
    expect(extensions.getExtension).toHaveBeenCalled();
    expect(mockApi.registerProvider).toHaveBeenCalledTimes(3);
    expect(mockApi.registerRunWatcher).toHaveBeenCalledTimes(1);
    expect(mockApi.registerPRWatcher).toHaveBeenCalledTimes(1);
    expect(workspace.onDidChangeConfiguration).toHaveBeenCalled();
  });

  it('returns early when core extension is not found', async () => {
    vi.mocked(extensions.getExtension).mockReturnValue(undefined as any);

    await activate(mockContext);

    expect(mockApi.registerProvider).not.toHaveBeenCalled();
  });

  it('reads the core extension exports directly without invoking activate', async () => {
    const mockActivate = vi.fn();
    vi.mocked(extensions.getExtension).mockReturnValue({
      isActive: false,
      exports: mockApi,
      activate: mockActivate,
    } as any);

    await activate(mockContext);

    expect(mockActivate).not.toHaveBeenCalled();
    expect(mockApi.registerProvider).toHaveBeenCalledTimes(3);
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

  it('returns when core extension API is null', async () => {
    vi.mocked(extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: null,
      activate: vi.fn(),
    } as any);

    await activate(mockContext);

    expect(mockApi.registerProvider).not.toHaveBeenCalled();
  });

  it('registers three providers when organization is configured', async () => {
    await activate(mockContext);

    expect(mockApi.registerProvider).toHaveBeenCalledTimes(3);

    // Verify provider objects passed
    const firstProvider = mockApi.registerProvider.mock.calls[0][0];
    const secondProvider = mockApi.registerProvider.mock.calls[1][0];
    const thirdProvider = mockApi.registerProvider.mock.calls[2][0];
    expect(firstProvider.id).toBe('ado-work-items');
    expect(secondProvider.id).toBe('ado-pr-reviews');
    expect(thirdProvider.id).toBe('ado-my-prs');
  });

  it('pushes static watcher registrations and configurable lifecycle owner onto subscriptions', async () => {
    await activate(mockContext);

    expect(mockApi.registerProvider).toHaveBeenCalledTimes(3);
    expect(mockApi.registerRunWatcher).toHaveBeenCalledTimes(1);
    expect(mockApi.registerPRWatcher).toHaveBeenCalledTimes(1);
    expect(disposables).toContain(runWatcherDisposable);
    expect(disposables).toContain(prWatcherDisposable);
    expect(disposables).toHaveLength(5);

    const lifecycleOwner = disposables.find(disposable =>
      disposable !== runWatcherDisposable &&
      disposable !== prWatcherDisposable &&
      disposable?.dispose &&
      !('appendLine' in disposable),
    );
    expect(lifecycleOwner).toBeDefined();
  });

  it('disposes configurable providers and registrations on shutdown', async () => {
    await activate(mockContext);

    const providers = mockApi.registerProvider.mock.calls.map(([provider]: any[]) => provider);
    const providerDisposeSpies = providers.map((provider: any) => vi.spyOn(provider, 'dispose'));

    disposeContextSubscriptions();
    await new Promise(resolve => setTimeout(resolve, 0));

    for (const registration of providerRegistrationDisposables) {
      expect(registration.dispose).toHaveBeenCalledTimes(1);
    }
    for (const providerDisposeSpy of providerDisposeSpies) {
      expect(providerDisposeSpy).toHaveBeenCalledTimes(1);
    }
    expect(runWatcherDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(prWatcherDisposable.dispose).toHaveBeenCalledTimes(1);
  });

  it('waits for provider shutdown before replacing ADO providers on config changes', async () => {
    await activate(mockContext);

    const firstRegistrations = [...providerRegistrationDisposables];
    const firstProviders = mockApi.registerProvider.mock.calls.map(([provider]: any[]) => provider);
    const firstProviderDisposeSpies = firstProviders.map((provider: any) => vi.spyOn(provider, 'dispose'));

    let resolveShutdown!: () => void;
    const shutdownGate = new Promise<void>(resolve => {
      resolveShutdown = resolve;
    });
    const firstShutdownSpy = vi.spyOn(firstProviders[0], 'shutdown').mockReturnValue(shutdownGate);

    for (const [listener] of vi.mocked(workspace.onDidChangeConfiguration).mock.calls) {
      listener({
        affectsConfiguration: (key: string) => key === 'devDocketAdo.projects',
      });
    }

    await Promise.resolve();
    expect(firstShutdownSpy).toHaveBeenCalledTimes(1);
    expect(mockApi.registerProvider).toHaveBeenCalledTimes(3);

    resolveShutdown();
    await vi.waitFor(() => expect(mockApi.registerProvider).toHaveBeenCalledTimes(6));

    for (const registration of firstRegistrations) {
      expect(registration.dispose).toHaveBeenCalledTimes(1);
    }
    for (const providerDisposeSpy of firstProviderDisposeSpies) {
      expect(providerDisposeSpy).toHaveBeenCalledTimes(1);
    }
    expect(mockApi.registerRunWatcher).toHaveBeenCalledTimes(1);
    expect(mockApi.registerPRWatcher).toHaveBeenCalledTimes(1);
  });

  it('replaces ADO providers even when shutdown rejects', async () => {
    await activate(mockContext);

    const firstRegistrations = [...providerRegistrationDisposables];
    const firstProviders = mockApi.registerProvider.mock.calls.map(([provider]: any[]) => provider);
    const firstProviderDisposeSpies = firstProviders.map((provider: any) => vi.spyOn(provider, 'dispose'));
    vi.spyOn(firstProviders[0], 'shutdown').mockRejectedValue(new Error('shutdown failed'));

    for (const [listener] of vi.mocked(workspace.onDidChangeConfiguration).mock.calls) {
      listener({
        affectsConfiguration: (key: string) => key === 'devDocketAdo.refreshIntervalSeconds',
      });
    }

    await vi.waitFor(() => expect(mockApi.registerProvider).toHaveBeenCalledTimes(6));

    for (const registration of firstRegistrations) {
      expect(registration.dispose).toHaveBeenCalledTimes(1);
    }
    for (const providerDisposeSpy of firstProviderDisposeSpies) {
      expect(providerDisposeSpy).toHaveBeenCalledTimes(1);
    }
  });

  it('does not register replacement ADO providers after disposal starts', async () => {
    await activate(mockContext);

    const firstProviders = mockApi.registerProvider.mock.calls.map(([provider]: any[]) => provider);
    let resolveShutdown!: () => void;
    const shutdownGate = new Promise<void>(resolve => {
      resolveShutdown = resolve;
    });
    vi.spyOn(firstProviders[0], 'shutdown').mockReturnValue(shutdownGate);

    for (const [listener] of vi.mocked(workspace.onDidChangeConfiguration).mock.calls) {
      listener({
        affectsConfiguration: (key: string) => key === 'devDocketAdo.projects',
      });
    }

    await Promise.resolve();
    disposeContextSubscriptions();
    resolveShutdown();

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockApi.registerProvider).toHaveBeenCalledTimes(3);
  });

  it('does not register providers when no organization is configured', async () => {
    vi.mocked(workspace.getConfiguration).mockImplementation((section?: string) => {
      if (section === 'devDocketAdo') {
        return {
          get: vi.fn((key: string, defaultValue?: any) => {
            if (key === 'organization') return '';
            if (key === 'projects') return [];
            if (key === 'refreshIntervalSeconds') return 0;
            return defaultValue;
          }),
        } as any;
      }
      return {
        get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
      } as any;
    });

    await activate(mockContext);

    expect(mockApi.registerProvider).not.toHaveBeenCalled();
  });

  it('opens ADO projects settings from the missing-projects warning', async () => {
    vi.mocked(window.showWarningMessage).mockResolvedValue('Open Settings' as any);
    vi.mocked(workspace.getConfiguration).mockImplementation((section?: string) => {
      if (section === 'devDocketAdo') {
        return {
          get: vi.fn((key: string, defaultValue?: any) => {
            if (key === 'organization') return '';
            if (key === 'projects') return [];
            if (key === 'refreshIntervalSeconds') return 0;
            return defaultValue;
          }),
        } as any;
      }
      return {
        get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
      } as any;
    });

    await activate(mockContext);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('No Azure DevOps organizations configured'),
      'Open Settings',
    );
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.openSettings',
      'devDocketAdo.projects',
    );
  });

  it('opens ADO projects settings from the invalid-projects warning', async () => {
    vi.mocked(window.showWarningMessage).mockResolvedValue('Open Settings' as any);
    vi.mocked(workspace.getConfiguration).mockImplementation((section?: string) => {
      if (section === 'devDocketAdo') {
        return {
          get: vi.fn((key: string, defaultValue?: any) => {
            if (key === 'projects') return [' / '];
            if (key === 'refreshIntervalSeconds') return 0;
            return defaultValue;
          }),
        } as any;
      }
      return {
        get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
      } as any;
    });

    await activate(mockContext);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('entries are invalid'),
      'Open Settings',
    );
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.openSettings',
      'devDocketAdo.projects',
    );
  });

  it('creates an output channel', async () => {
    await activate(mockContext);

    expect(window.createOutputChannel).toHaveBeenCalledWith('DevDocket Azure DevOps', { log: true });
    expect(disposables.length).toBeGreaterThan(0);
  });

  it('registers configuration change listener', async () => {
    await activate(mockContext);

    expect(workspace.onDidChangeConfiguration).toHaveBeenCalled();
  });

  it('deactivate is a no-op', () => {
    // Just ensure it doesn't throw
    expect(() => deactivate()).not.toThrow();
  });
});
