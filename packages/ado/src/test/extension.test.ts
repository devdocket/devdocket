import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { workspace, extensions, window } from 'vscode';
import { activate, deactivate } from '../extension';

// Stub fetch globally to prevent real network calls from provider.refresh()
const mockFetch = vi.fn();

describe('extension activation', () => {
  let mockContext: any;
  let mockApi: any;
  let disposables: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);

    // Add createOutputChannel to window mock (not in default vscode mock)
    (window as any).createOutputChannel = vi.fn(() => ({
      appendLine: vi.fn(),
      dispose: vi.fn(),
    }));

    disposables = [];
    mockContext = {
      subscriptions: {
        push: (...items: any[]) => disposables.push(...items),
      },
    };

    mockApi = {
      registerProvider: vi.fn(() => ({ dispose: vi.fn() })),
    };

    // Default: core extension found and active with valid API
    vi.mocked(extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: mockApi,
      activate: vi.fn(),
    } as any);

    // Default: organization configured
    vi.mocked(workspace.getConfiguration).mockImplementation((section?: string) => {
      if (section === 'devdocketAdo') {
        return {
          get: vi.fn((key: string, defaultValue?: any) => {
            if (key === 'organization') return 'myorg';
            if (key === 'projects') return ['ProjectA'];
            if (key === 'refreshIntervalSeconds') return 0;
            return defaultValue;
          }),
        } as any;
      }
      // devdocket config for log level
      return {
        get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
      } as any;
    });
  });

  afterEach(() => {
    for (const d of disposables) {
      if (d && typeof d.dispose === 'function') {
        d.dispose();
      }
    }
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

  it('returns when core extension API is null', async () => {
    vi.mocked(extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: null,
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
    expect(mockApi.registerProvider).toHaveBeenCalledTimes(3);
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
    expect(thirdProvider.id).toBe('ado-pipelines');
  });

  it('does not register providers when no organization is configured', async () => {
    vi.mocked(workspace.getConfiguration).mockImplementation((section?: string) => {
      if (section === 'devdocketAdo') {
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

  it('creates an output channel', async () => {
    await activate(mockContext);

    // Output channel is pushed to subscriptions (first subscription)
    expect(disposables.length).toBeGreaterThan(0);
  });

  it('registers configuration change listener', async () => {
    await activate(mockContext);

    expect(workspace.onDidChangeConfiguration).toHaveBeenCalled();
  });

  it('registers only two providers when watchPipelineRuns is disabled', async () => {
    vi.mocked(workspace.getConfiguration).mockImplementation((section?: string) => {
      if (section === 'devdocketAdo') {
        return {
          get: vi.fn((key: string, defaultValue?: any) => {
            if (key === 'projects') return ['ProjectA'];
            if (key === 'refreshIntervalSeconds') return 0;
            if (key === 'watchPipelineRuns') return false;
            return defaultValue;
          }),
        } as any;
      }
      return {
        get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
      } as any;
    });

    await activate(mockContext);

    expect(mockApi.registerProvider).toHaveBeenCalledTimes(2);
    const firstProvider = mockApi.registerProvider.mock.calls[0][0];
    const secondProvider = mockApi.registerProvider.mock.calls[1][0];
    expect(firstProvider.id).toBe('ado-work-items');
    expect(secondProvider.id).toBe('ado-pr-reviews');
  });

  it('deactivate is a no-op', () => {
    // Just ensure it doesn't throw
    expect(() => deactivate()).not.toThrow();
  });
});
