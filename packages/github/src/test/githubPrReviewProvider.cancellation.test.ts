import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, workspace } from 'vscode';
import { GitHubPrReviewProvider } from '../githubPrReviewProvider';
import { initLogger, LogLevel } from '../logger';

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

function createMockPr(number: number, title: string, repo = 'owner/repo') {
  return {
    number,
    title,
    body: `Body for PR ${number}`,
    html_url: `https://github.com/${repo}/pull/${number}`,
    repository_url: `https://api.github.com/repos/${repo}`,
    pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}` },
  };
}

describe('GitHubPrReviewProvider — cancellation (AbortSignal wiring)', () => {
  let provider: GitHubPrReviewProvider;
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new GitHubPrReviewProvider();

    mockChannel = { appendLine: vi.fn() };
    initLogger(mockChannel as any, LogLevel.Debug);

    // Disable resurfacing features to avoid extra API calls
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'resurfaceOnNewVersion' || key === 'resurfaceOnReRequestedReview') {
          return false;
        }
        return defaultValue;
      }),
    } as any);

    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['repo'],
      account: { id: '1', label: 'testuser' },
    } as any);
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  // ── Signal wiring ──────────────────────────────────────────────────

  describe('AbortSignal passed to fetch', () => {
    it('passes AbortSignal to search fetch', async () => {
      const { token } = createMockCancellationToken();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      });

      await provider.refresh(token);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchOptions = mockFetch.mock.calls[0][1];
      expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    });

    it('passes AbortSignal to head SHA fetch calls when resurfacing is enabled', async () => {
      const { token } = createMockCancellationToken();
      const pr = createMockPr(1, 'Test PR');

      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'resurfaceOnNewVersion') { return true; }
          if (key === 'resurfaceOnReRequestedReview') { return false; }
          return defaultValue;
        }),
      } as any);

      mockFetch
        // Search response
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ items: [pr] }),
        })
        // Head SHA fetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ head: { sha: 'abc123' } }),
        });

      await provider.refresh(token);

      // Both calls should have signal
      for (const call of mockFetch.mock.calls) {
        expect(call[1].signal).toBeInstanceOf(AbortSignal);
      }
    });
  });

  // ── Mid-fetch cancellation ─────────────────────────────────────────

  describe('mid-fetch cancellation', () => {
    it('does not publish items when token fires during search', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementation(async () => {
        cancel();
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token);

      expect(listener).not.toHaveBeenCalled();
    });

    it('does not publish items when abort happens during head SHA fetch', async () => {
      const { token, cancel } = createMockCancellationToken();
      const prs = Array.from({ length: 3 }, (_, i) => createMockPr(i + 1, `PR ${i + 1}`));

      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'resurfaceOnNewVersion') { return true; }
          if (key === 'resurfaceOnReRequestedReview') { return false; }
          return defaultValue;
        }),
      } as any);

      let fetchCount = 0;
      mockFetch.mockImplementation(async () => {
        fetchCount++;
        if (fetchCount === 1) {
          // Search succeeds
          return { ok: true, json: async () => ({ items: prs }) };
        }
        // Head SHA fetches: cancel on second one
        if (fetchCount >= 3) {
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        return { ok: true, json: async () => ({ head: { sha: 'abc' } }) };
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token);

      expect(listener).not.toHaveBeenCalled();
    });

    it('logs cancellation at debug level, not error level', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementation(async () => {
        cancel();
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      });

      await provider.refresh(token);

      const debugLogged = mockChannel.appendLine.mock.calls.some(
        (call: string[]) => call[0].includes('[DEBUG]') && call[0].includes('fetch aborted'),
      );
      expect(debugLogged).toBe(true);

      const errorLogged = mockChannel.appendLine.mock.calls.some(
        (call: string[]) => call[0].includes('[ERROR]') && call[0].includes('Failed to fetch'),
      );
      expect(errorLogged).toBe(false);
    });
  });

  // ── Worker pool abort ──────────────────────────────────────────────

  describe('worker pool abort', () => {
    it('stops head SHA worker pool when signal is aborted', async () => {
      const { token, cancel } = createMockCancellationToken();
      const prs = Array.from({ length: 5 }, (_, i) => createMockPr(i + 1, `PR ${i + 1}`));

      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'resurfaceOnNewVersion') { return true; }
          if (key === 'resurfaceOnReRequestedReview') { return false; }
          return defaultValue;
        }),
      } as any);

      let fetchCount = 0;
      mockFetch.mockImplementation(async () => {
        fetchCount++;
        if (fetchCount === 1) {
          // Search succeeds
          return { ok: true, json: async () => ({ items: prs }) };
        }
        // Head SHA fetches: cancel on second one
        if (fetchCount >= 3) {
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        return { ok: true, json: async () => ({ head: { sha: 'abc' } }) };
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token);

      // Should NOT have fetched all 5 PRs' head SHAs
      expect(fetchCount).toBeLessThan(6);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── Cleanup ────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('disposes cancelListener after abort', async () => {
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

    it('resets _isRefreshing after abort', async () => {
      const { token, cancel } = createMockCancellationToken();

      mockFetch.mockImplementationOnce(async () => {
        cancel();
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      });

      await provider.refresh(token);

      // Next refresh should proceed
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalled();
    });
  });
});
