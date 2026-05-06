import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { workspace, extensions, window } from 'vscode';
import { activate, deactivate } from '../extension';

const mockFetch = vi.fn();

describe('GitHub extension activation', () => {
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

    (window as any).createOutputChannel = vi.fn(() => ({
      appendLine: vi.fn(),
      append: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      name: 'DevDocket GitHub',
      replace: vi.fn(),
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

    vi.mocked(extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: mockApi,
      activate: vi.fn(),
    } as any);

    vi.mocked(workspace.getConfiguration).mockImplementation((section?: string) => {
      if (section === 'devDocketGithub') {
        return {
          get: vi.fn((key: string, defaultValue?: any) => {
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

  it('returns early when core extension is not found', async () => {
    vi.mocked(extensions.getExtension).mockReturnValue(undefined as any);

    await activate(mockContext);

    expect(mockApi.registerProvider).not.toHaveBeenCalled();
  });

  it('shows error and returns when core extension fails to activate', async () => {
    vi.mocked(extensions.getExtension).mockReturnValue({
      isActive: false,
      exports: undefined,
      activate: vi.fn().mockRejectedValue(new Error('Activation failed')),
    } as any);

    await activate(mockContext);

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to activate core extension'),
    );
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

  it('activates core extension when not yet active', async () => {
    const mockActivate = vi.fn().mockResolvedValue(mockApi);
    vi.mocked(extensions.getExtension).mockReturnValue({
      isActive: false,
      exports: undefined,
      activate: mockActivate,
    } as any);

    await activate(mockContext);

    expect(mockActivate).toHaveBeenCalled();
    expect(mockApi.registerProvider).toHaveBeenCalledTimes(4);
  });

  it('pushes provider, registration, and watcher disposables onto subscriptions', async () => {
    await activate(mockContext);

    const providerIds = mockApi.registerProvider.mock.calls.map(([provider]: any[]) => provider.id);
    expect(providerIds).toEqual([
      'github',
      'github-pr-reviews',
      'github-my-prs',
      'github-mentions',
    ]);
    expect(mockApi.registerRunWatcher).toHaveBeenCalledTimes(1);
    expect(mockApi.registerPRWatcher).toHaveBeenCalledTimes(1);

    const subscribedProviderIds = disposables
      .filter(disposable => providerIds.includes(disposable?.id))
      .map(disposable => disposable.id);
    expect(subscribedProviderIds).toEqual(providerIds);
    for (const registration of providerRegistrationDisposables) {
      expect(disposables).toContain(registration);
    }
    expect(disposables).toContain(runWatcherDisposable);
    expect(disposables).toContain(prWatcherDisposable);
    expect(disposables).toHaveLength(12);
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
    expect(runWatcherDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(prWatcherDisposable.dispose).toHaveBeenCalledTimes(1);
  });

  it('deactivate is a no-op', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
