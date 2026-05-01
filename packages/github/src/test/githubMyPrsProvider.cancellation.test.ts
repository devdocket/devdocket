import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, workspace } from 'vscode';
import { GitHubMyPrsProvider, type PrDetail, type PrReview } from '../githubMyPrsProvider';
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
    state: 'open',
    html_url: `https://github.com/${repo}/pull/${number}`,
    repository_url: `https://api.github.com/repos/${repo}`,
    pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}` },
  };
}

function mockSearchResponse(items: ReturnType<typeof createMockPr>[]) {
  return { ok: true, json: async () => ({ items }) };
}

function mockPrDetailResponse(detail: PrDetail) {
  return { ok: true, json: async () => detail };
}

function mockReviewsResponse(reviews: PrReview[]) {
  return { ok: true, json: async () => reviews };
}

describe('GitHubMyPrsProvider — cancellation (AbortSignal wiring)', () => {
  let provider: GitHubMyPrsProvider;
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new GitHubMyPrsProvider();

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
    it('passes AbortSignal to search fetch', async () => {
      const { token } = createMockCancellationToken();
      mockFetch.mockResolvedValue(mockSearchResponse([]));

      await provider.refresh(token);

      // 2 calls: author:@me and assignee:@me
      expect(mockFetch).toHaveBeenCalledTimes(2);
      for (const call of mockFetch.mock.calls) {
        expect(call[1].signal).toBeInstanceOf(AbortSignal);
      }
    });

    it('passes AbortSignal to PR detail and review fetch calls', async () => {
      const { token } = createMockCancellationToken();
      const pr = createMockPr(1, 'Test PR');

      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('search/issues') && url.includes('author:@me')) {
          return mockSearchResponse([pr]);
        }
        if (url.includes('search/issues') && url.includes('assignee:@me')) {
          return mockSearchResponse([]);
        }
        if (url.endsWith('/pulls/1')) {
          return mockPrDetailResponse({ draft: false });
        }
        if (url.endsWith('/pulls/1/reviews')) {
          return mockReviewsResponse([]);
        }
        return { ok: false, status: 404 };
      });

      await provider.refresh(token);

      // 5 calls: 2 search + PR detail + reviews + related-items GraphQL lookup
      expect(mockFetch).toHaveBeenCalledTimes(5);
      for (const call of mockFetch.mock.calls) {
        expect(call[1].signal).toBeInstanceOf(AbortSignal);
      }
    });
  });

  // ── Mid-fetch cancellation ─────────────────────────────────────────

  describe('mid-fetch cancellation', () => {
    it('does not publish items when token fires during search fetch', async () => {
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

    it('does not publish items when token fires during PR status fetch', async () => {
      const { token, cancel } = createMockCancellationToken();
      const pr = createMockPr(1, 'Test PR');

      let fetchCount = 0;
      mockFetch.mockImplementation(async () => {
        fetchCount++;
        if (fetchCount === 1) {
          // Search succeeds
          return mockSearchResponse([pr]);
        }
        // PR detail fetch: cancel fires
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

    it('logs cancellation at debug level', async () => {
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
    it('stops fetching PR statuses when signal is aborted between workers', async () => {
      const { token, cancel } = createMockCancellationToken();

      const prs = Array.from({ length: 5 }, (_, i) => createMockPr(i + 1, `PR ${i + 1}`));

      let statusFetchCount = 0;
      mockFetch.mockImplementation(async (url: string) => {
        // Search call
        if (url.includes('search/issues')) {
          return mockSearchResponse(prs);
        }
        // PR detail/review calls
        statusFetchCount++;
        if (statusFetchCount >= 3) {
          // After a few status fetches, cancel
          cancel();
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        if (url.includes('/reviews')) {
          return mockReviewsResponse([]);
        }
        return mockPrDetailResponse({ draft: false });
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh(token);

      // Should NOT have fetched all 5 PRs × 2 calls = 10 status fetches
      expect(statusFetchCount).toBeLessThan(10);
      // No items published due to abort
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

      mockFetch.mockImplementation(async () => {
        cancel();
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      });

      await provider.refresh(token);

      // Next refresh should proceed
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('search/issues')) {
          return mockSearchResponse([]);
        }
        return { ok: false, status: 404 };
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalled();
    });
  });
});
