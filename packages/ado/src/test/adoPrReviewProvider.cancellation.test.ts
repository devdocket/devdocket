import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication } from 'vscode';
import { AdoPrReviewProvider } from '../adoPrReviewProvider';
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

describe('AdoPrReviewProvider — cancellation (AbortSignal wiring)', () => {
  let provider: AdoPrReviewProvider;
  let mockChannel: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new AdoPrReviewProvider([{ org: 'myorg', projects: ['MyProject'] }]);

    mockChannel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() };
    setLogger(mockChannel);

    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      account: { id: '1', label: 'testuser' },
    } as any);
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  // ── Signal wiring ──────────────────────────────────────────────────

  describe('AbortSignal passed to fetch', () => {
    it('passes AbortSignal to connection data fetch', async () => {
      const { token } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/connectiondata')) {
          return {
            ok: true,
            json: async () => ({ authenticatedUser: { id: 'user-123' } }),
          };
        }
        if (typeof url === 'string' && url.includes('/pullrequests')) {
          return { ok: true, json: async () => ({ count: 0, value: [] }) };
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      await provider.refresh(token);

      const connectionCall = mockFetch.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('/connectiondata'),
      );
      expect(connectionCall).toBeDefined();
      expect(connectionCall![1].signal).toBeInstanceOf(AbortSignal);
    });

    it('passes AbortSignal to pull request list fetch', async () => {
      const { token } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/connectiondata')) {
          return {
            ok: true,
            json: async () => ({ authenticatedUser: { id: 'user-123' } }),
          };
        }
        if (typeof url === 'string' && url.includes('/pullrequests')) {
          return { ok: true, json: async () => ({ count: 0, value: [] }) };
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      await provider.refresh(token);

      const prCall = mockFetch.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('/pullrequests'),
      );
      expect(prCall).toBeDefined();
      expect(prCall![1].signal).toBeInstanceOf(AbortSignal);
    });
  });

  // ── Mid-fetch cancellation ─────────────────────────────────────────

  describe('mid-fetch cancellation', () => {
    it('does not publish items when token fires during connection data fetch', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/connectiondata')) {
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token);

      // AbortError → no items published
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not publish items when token fires during PR list fetch', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/connectiondata')) {
          return {
            ok: true,
            json: async () => ({ authenticatedUser: { id: 'user-123' } }),
          };
        }
        if (typeof url === 'string' && url.includes('/pullrequests')) {
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token);

      expect(listener).not.toHaveBeenCalled();
    });

    it('does not log fetch errors when token fires during PR list fetch', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/connectiondata')) {
          return {
            ok: true,
            json: async () => ({ authenticatedUser: { id: 'user-123' } }),
          };
        }
        if (typeof url === 'string' && url.includes('/pullrequests')) {
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      await provider.refresh(token);

      const prFetchErrorLogged = mockChannel.error.mock.calls.some(
        (call: unknown[]) => String(call[0]).includes('PR reviews from'),
      );
      expect(prFetchErrorLogged).toBe(false);
    });

    it('logs cancellation at debug level, not error', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/connectiondata')) {
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
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
  });

  // ── Cleanup ────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('disposes cancelListener after abort', async () => {
      const { token, cancel, disposeStubs } = createMockCancellationToken();

      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/connectiondata')) {
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
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
        if (typeof url === 'string' && url.includes('/connectiondata')) {
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      await provider.refresh(token);

      // Reset mock for normal operation
      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/connectiondata')) {
          return {
            ok: true,
            json: async () => ({ authenticatedUser: { id: 'user-123' } }),
          };
        }
        if (typeof url === 'string' && url.includes('/pullrequests')) {
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
