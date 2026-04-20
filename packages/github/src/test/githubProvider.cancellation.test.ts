import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, workspace } from 'vscode';
import { GitHubIssueProvider } from '../githubProvider';
import { initLogger, LogLevel } from '../logger';

const mockFetch = vi.fn();
const noLinkHeaders = { get: () => null };

/**
 * Creates a mock CancellationToken with a working onCancellationRequested
 * callback, mirroring real vscode.CancellationToken behavior.
 */
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

function createMockIssue(number: number, title: string, repo = 'owner/repo') {
  return {
    number,
    title,
    body: `Body for issue ${number}`,
    html_url: `https://github.com/${repo}/issues/${number}`,
    repository_url: `https://api.github.com/repos/${repo}`,
  };
}

function configureRepos(repos: string[]) {
  vi.mocked(workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, defaultValue?: any) => {
      if (key === 'repos') { return repos; }
      return defaultValue;
    }),
  } as any);
}

describe('GitHubIssueProvider — cancellation (AbortSignal wiring)', () => {
  let provider: GitHubIssueProvider;
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new GitHubIssueProvider();

    mockChannel = { appendLine: vi.fn() };
    initLogger(mockChannel as any, LogLevel.Debug);

    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['repo'],
      account: { id: '1', label: 'testuser' },
    } as any);

    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
    } as any);
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  // ── Signal wiring ──────────────────────────────────────────────────

  describe('AbortSignal passed to fetch', () => {
    it('passes an AbortSignal to fetch when CancellationToken is provided', async () => {
      const { token } = createMockCancellationToken();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: noLinkHeaders,
        json: async () => [],
      });

      await provider.refresh(token);

      expect(mockFetch).toHaveBeenCalled();
      const fetchOptions = mockFetch.mock.calls[0][1];
      expect(fetchOptions).toHaveProperty('signal');
      expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    });

    it('passes AbortSignal derived from same source to paginated fetch calls', async () => {
      const { token, cancel } = createMockCancellationToken();

      // Page 1 with Link header pointing to page 2
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: (h: string) => h === 'link' ? '<https://api.github.com/issues?page=2>; rel="next"' : null },
          json: async () => [createMockIssue(1, 'Issue 1')],
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: noLinkHeaders,
          json: async () => [createMockIssue(2, 'Issue 2')],
        });

      await provider.refresh(token);

      // Both fetch calls should have AbortSignal instances (combineSignals wraps per-call)
      const signal1 = mockFetch.mock.calls[0][1]?.signal;
      const signal2 = mockFetch.mock.calls[1][1]?.signal;
      expect(signal1).toBeInstanceOf(AbortSignal);
      expect(signal2).toBeInstanceOf(AbortSignal);
    });

    it('passes AbortSignal to per-repo fetch calls', async () => {
      const { token } = createMockCancellationToken();
      configureRepos(['owner/repo1', 'owner/repo2']);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          headers: noLinkHeaders,
          json: async () => [createMockIssue(1, 'Issue 1', 'owner/repo1')],
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: noLinkHeaders,
          json: async () => [createMockIssue(2, 'Issue 2', 'owner/repo2')],
        });

      await provider.refresh(token);

      for (const call of mockFetch.mock.calls) {
        expect(call[1]).toHaveProperty('signal');
        expect(call[1].signal).toBeInstanceOf(AbortSignal);
      }
    });
  });

  // ── Mid-fetch cancellation ─────────────────────────────────────────

  describe('mid-fetch cancellation', () => {
    it('does not publish items when token fires during fetch', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementation(async () => {
        // Simulate: token fires while waiting for network response
        cancel();
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token);

      // No items should be published — preserves previous provider state
      expect(listener).not.toHaveBeenCalled();
    });

    it('logs AbortError at debug level, not error level', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementation(async () => {
        cancel();
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      });

      await provider.refresh(token);

      // Should log "fetch aborted" at debug level
      const debugLogged = mockChannel.appendLine.mock.calls.some(
        (call: string[]) => call[0].includes('[DEBUG]') && call[0].includes('fetch aborted'),
      );
      expect(debugLogged).toBe(true);

      // Should NOT log at error level
      const errorLogged = mockChannel.appendLine.mock.calls.some(
        (call: string[]) => call[0].includes('[ERROR]') && call[0].includes('Failed to fetch'),
      );
      expect(errorLogged).toBe(false);
    });

    it('does not publish partial results when abort happens during per-repo fetch', async () => {
      const { token, cancel } = createMockCancellationToken();
      configureRepos(['owner/repo1', 'owner/repo2']);

      let fetchCount = 0;
      mockFetch.mockImplementation(async () => {
        fetchCount++;
        if (fetchCount === 1) {
          // First repo succeeds
          return {
            ok: true,
            headers: noLinkHeaders,
            json: async () => [createMockIssue(1, 'Issue 1', 'owner/repo1')],
          };
        }
        // Second repo: cancel fires mid-fetch
        cancel();
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token);

      // Even though repo1 succeeded, no items should be published
      // because the overall operation was cancelled
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── Pre-cancelled token ────────────────────────────────────────────

  describe('already-cancelled token', () => {
    it('returns immediately without fetching when token is already cancelled', async () => {
      const token = {
        isCancellationRequested: true,
        onCancellationRequested: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      };

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token as any);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(authentication.getSession).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });

    it('returns without fetching when token is cancelled during auth', async () => {
      const { token, cancel } = createMockCancellationToken();

      vi.mocked(authentication.getSession).mockImplementation(async () => {
        cancel();
        return {
          accessToken: 'test-token',
          id: 'session-1',
          scopes: ['repo'],
          account: { id: '1', label: 'testuser' },
        } as any;
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── cancelListener cleanup ─────────────────────────────────────────

  describe('cleanup', () => {
    it('disposes cancelListener after successful refresh', async () => {
      const { token, disposeStubs } = createMockCancellationToken();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: noLinkHeaders,
        json: async () => [],
      });

      await provider.refresh(token);

      expect(disposeStubs).toHaveLength(1);
      expect(disposeStubs[0]).toHaveBeenCalledTimes(1);
    });

    it('disposes cancelListener after aborted refresh', async () => {
      const { token, cancel, disposeStubs } = createMockCancellationToken();

      mockFetch.mockImplementation(async () => {
        cancel();
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      });

      await provider.refresh(token);

      expect(disposeStubs).toHaveLength(1);
      expect(disposeStubs[0]).toHaveBeenCalledTimes(1);
    });

    it('does not throw when refresh is called without token (no cancelListener)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: noLinkHeaders,
        json: async () => [],
      });

      // No token → cancelListener is undefined → dispose() should not be called
      await expect(provider.refresh()).resolves.toBeUndefined();
    });

    it('resets _isRefreshing after abort so subsequent refresh can proceed', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementationOnce(async () => {
        cancel();
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      });

      await provider.refresh(token);

      // Second refresh should proceed (not blocked by stale _isRefreshing)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: noLinkHeaders,
        json: async () => [createMockIssue(1, 'After abort')],
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalled();
      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
    });
  });

  // ── Pagination abort ───────────────────────────────────────────────

  describe('pagination abort', () => {
    it('stops fetching further pages when signal is aborted mid-pagination', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: (h: string) => h === 'link' ? '<https://api.github.com/issues?page=2>; rel="next"' : null },
          json: async () => [createMockIssue(1, 'Page 1 issue')],
        })
        .mockImplementation(async () => {
          // Page 2: cancel during fetch
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token);

      // Abort during pagination → no items published
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
