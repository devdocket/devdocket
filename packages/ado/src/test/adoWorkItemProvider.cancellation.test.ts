import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication } from 'vscode';
import { AdoWorkItemProvider } from '../adoWorkItemProvider';
import { setLogger } from '../logger';

const mockFetch = vi.fn();

function createMockCancellationToken() {
  let isCancellationRequested = false;
  const listeners: (() => void)[] = [];
  const disposeStubs: ReturnType<typeof vi.fn>[] = [];

  const token = {
    get isCancellationRequested() { return isCancellationRequested; },
    onCancellationRequested: (listener: () => void) => {
      listeners.push(listener);
      const dispose = vi.fn();
      disposeStubs.push(dispose);
      return { dispose };
    },
  };

  const cancel = () => {
    isCancellationRequested = true;
    listeners.forEach(l => l());
  };

  return { token: token as any, cancel, disposeStubs };
}

function createWiqlResponse(ids: number[]) {
  return {
    workItems: ids.map(id => ({ id, url: `https://dev.azure.com/myorg/_apis/wit/workitems/${id}` })),
  };
}

function createWorkItemDetail(id: number, title: string, project = 'MyProject', type = 'User Story') {
  return {
    id,
    fields: {
      'System.Title': title,
      'System.Description': `<p>Description for ${id}</p>`,
      'System.TeamProject': project,
      'System.WorkItemType': type,
      'System.State': 'Active',
    },
    _links: {
      html: { href: `https://dev.azure.com/myorg/${project}/_workitems/edit/${id}` },
    },
  };
}

describe('AdoWorkItemProvider — cancellation (AbortSignal wiring)', () => {
  let provider: AdoWorkItemProvider;
  let mockChannel: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new AdoWorkItemProvider([{ org: 'myorg', projects: ['MyProject'] }]);

    mockChannel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() };
    setLogger(mockChannel);

    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      account: { id: '1', label: 'testuser' },
    } as any);

    // Default fallback: states API calls return no terminal states
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/workitemtypes/') && url.includes('/states')) {
        return { ok: true, json: async () => ({ count: 0, value: [] }) };
      }
      throw new Error(`Unexpected fetch call in test: ${String(url)}`);
    });
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  // ── Signal wiring ──────────────────────────────────────────────────

  describe('AbortSignal passed to fetch', () => {
    it('passes AbortSignal to WIQL fetch call', async () => {
      const { token } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string, options?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/wiql')) {
          return {
            ok: true,
            json: async () => createWiqlResponse([]),
          };
        }
        if (typeof url === 'string' && url.includes('/workitemtypes/') && url.includes('/states')) {
          return { ok: true, json: async () => ({ count: 0, value: [] }) };
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      await provider.refresh(token);

      // Find the WIQL call
      const wiqlCall = mockFetch.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('/wiql'),
      );
      expect(wiqlCall).toBeDefined();
      expect(wiqlCall![1].signal).toBeInstanceOf(AbortSignal);
    });

    it('passes AbortSignal to work item detail fetch calls', async () => {
      const { token } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/wiql')) {
          return { ok: true, json: async () => createWiqlResponse([1]) };
        }
        if (typeof url === 'string' && url.includes('/workitems?ids=')) {
          return {
            ok: true,
            json: async () => ({ count: 1, value: [createWorkItemDetail(1, 'Test Item')] }),
          };
        }
        if (typeof url === 'string' && url.includes('/workitemtypes/') && url.includes('/states')) {
          return { ok: true, json: async () => ({ count: 0, value: [] }) };
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      await provider.refresh(token);

      // All fetch calls should have signal
      for (const call of mockFetch.mock.calls) {
        expect(call[1]).toHaveProperty('signal');
        expect(call[1].signal).toBeInstanceOf(AbortSignal);
      }
    });
  });

  // ── Mid-fetch cancellation ─────────────────────────────────────────

  describe('mid-fetch cancellation', () => {
    it('does not publish items when token fires during WIQL fetch', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/wiql')) {
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        if (typeof url === 'string' && url.includes('/workitemtypes/') && url.includes('/states')) {
          return { ok: true, json: async () => ({ count: 0, value: [] }) };
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token);

      // AbortError should NOT fire empty items — preserves previous state
      expect(listener).not.toHaveBeenCalled();
    });

    it('logs cancellation at debug level, not error', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/wiql')) {
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        if (typeof url === 'string' && url.includes('/workitemtypes/') && url.includes('/states')) {
          return { ok: true, json: async () => ({ count: 0, value: [] }) };
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      await provider.refresh(token);

      const debugLogged = mockChannel.debug.mock.calls.some(
        (call: unknown[]) => String(call[0]).includes('aborted'),
      );
      expect(debugLogged).toBe(true);

      const errorLogged = mockChannel.error.mock.calls.some(
        (call: unknown[]) => String(call[0]).includes('Failed to fetch'),
      );
      expect(errorLogged).toBe(false);
    });

    it('does not publish partial results when abort happens during detail fetch', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/wiql')) {
          return { ok: true, json: async () => createWiqlResponse([1, 2, 3]) };
        }
        if (typeof url === 'string' && url.includes('/workitems?ids=')) {
          // Cancel during detail fetch
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        if (typeof url === 'string' && url.includes('/workitemtypes/') && url.includes('/states')) {
          return { ok: true, json: async () => ({ count: 0, value: [] }) };
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token);

      // No partial items published
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── Cleanup ────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('disposes cancelListener after abort', async () => {
      const { token, cancel, disposeStubs } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/wiql')) {
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        if (typeof url === 'string' && url.includes('/workitemtypes/') && url.includes('/states')) {
          return { ok: true, json: async () => ({ count: 0, value: [] }) };
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      await provider.refresh(token);

      expect(disposeStubs).toHaveLength(1);
      expect(disposeStubs[0]).toHaveBeenCalledTimes(1);
    });

    it('resets _isRefreshing after abort', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementationOnce(async (url: string) => {
        if (typeof url === 'string' && url.includes('/wiql')) {
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      await provider.refresh(token);

      // Reset mock to normal behavior for second refresh
      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/wiql')) {
          return { ok: true, json: async () => createWiqlResponse([]) };
        }
        if (typeof url === 'string' && url.includes('/workitemtypes/') && url.includes('/states')) {
          return { ok: true, json: async () => ({ count: 0, value: [] }) };
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalled();
    });
  });
});
