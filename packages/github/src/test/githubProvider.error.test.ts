import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, workspace, window } from 'vscode';
import { GitHubIssueProvider } from '../githubProvider';
import { initLogger, LogLevel } from '../logger';

const mockFetch = vi.fn();

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

describe('GitHubIssueProvider — error handling', () => {
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

    // Default: no configured repos
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
    } as any);
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  // ── Network errors ──────────────────────────────────────────────────

  describe('network errors', () => {
    it('handles fetch rejection (network timeout) without throwing', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network timeout'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await expect(provider.refresh()).resolves.toBeUndefined();
      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles TypeError from fetch (e.g. DNS failure)', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await expect(provider.refresh()).resolves.toBeUndefined();
      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles AbortError from fetch', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await expect(provider.refresh()).resolves.toBeUndefined();
      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles fetch rejection on configured repo without throwing', async () => {
      configureRepos(['owner/repo1']);
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Still fires event with empty items; the repo is recorded as failed
      expect(listener).toHaveBeenCalledWith([]);
    });
  });

  // ── HTTP status errors ──────────────────────────────────────────────

  describe('HTTP status errors', () => {
    it('handles 401 Unauthorized gracefully', async () => {
      configureRepos(['owner/repo1']);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles 403 rate-limited response gracefully', async () => {
      configureRepos(['owner/repo1']);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles 404 Not Found for invalid repo', async () => {
      configureRepos(['nonexistent/repo']);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles 500 Internal Server Error', async () => {
      configureRepos(['owner/repo1']);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles 401 on fallback endpoint (no repos configured)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles 500 on fallback endpoint (no repos configured)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });

    it('shows warning for user-triggered refresh when repo fails', async () => {
      configureRepos(['owner/repo1']);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      await provider.refresh();

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch issues'),
      );
    });

    it('does not show warning for background refresh when repo fails', async () => {
      configureRepos(['owner/repo1']);
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      const refreshBg = (provider as any).refreshInBackground.bind(provider);
      await refreshBg();

      expect(window.showWarningMessage).not.toHaveBeenCalled();
      const logged = mockChannel.appendLine.mock.calls.some(
        (call: string[]) => call[0].includes('[WARN]'),
      );
      expect(logged).toBe(true);
    });
  });

  // ── Malformed / unexpected responses ────────────────────────────────

  describe('malformed responses', () => {
    it('handles JSON parse error in response body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await expect(provider.refresh()).resolves.toBeUndefined();
      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles empty array response body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles issue with missing body field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => [{
          number: 1,
          title: 'No body',
          html_url: 'https://github.com/owner/repo/issues/1',
          repository_url: 'https://api.github.com/repos/owner/repo',
          body: undefined,
        }],
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].description).toBeUndefined();
    });

    it('handles issue with null body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => [{
          number: 1,
          title: 'Null body',
          html_url: 'https://github.com/owner/repo/issues/1',
          repository_url: 'https://api.github.com/repos/owner/repo',
          body: null,
        }],
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].description).toBeUndefined();
    });

    it('handles JSON parse error on a configured repo', async () => {
      configureRepos(['owner/repo1']);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Repo fetch promise rejects → treated as failure by allSettled
      expect(listener).toHaveBeenCalledWith([]);
    });
  });

  // ── Authentication edge cases ───────────────────────────────────────

  describe('authentication failures', () => {
    it('handles auth session returning null', async () => {
      vi.mocked(authentication.getSession).mockResolvedValue(null as any);

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('handles auth session throwing an error', async () => {
      vi.mocked(authentication.getSession).mockRejectedValue(
        new Error('Auth provider unavailable'),
      );

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await expect(provider.refresh()).resolves.toBeUndefined();
      expect(listener).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('handles auth session returning null during background refresh', async () => {
      vi.mocked(authentication.getSession).mockResolvedValue(null as any);

      const refreshBg = (provider as any).refreshInBackground.bind(provider);
      await refreshBg();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('handles auth session throwing during background refresh', async () => {
      vi.mocked(authentication.getSession).mockRejectedValue(
        new Error('Token expired'),
      );

      const refreshBg = (provider as any).refreshInBackground.bind(provider);
      await expect(refreshBg()).resolves.toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── Periodic refresh resilience ─────────────────────────────────────

  describe('periodic refresh continues after transient errors', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('periodic refresh continues after a fetch rejection', async () => {
      vi.useFakeTimers();

      // First tick: fetch rejects
      // Second tick: fetch succeeds
      let callCount = 0;
      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('transient failure');
        }
      });

      provider.startPeriodicRefresh(60);

      vi.advanceTimersByTime(60_000);
      // Timer's .catch() swallows the error; timer still alive
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshSpy).toHaveBeenCalledTimes(2);
    });

    it('does not call refreshInBackground concurrently when already refreshing', async () => {
      // Directly set the guard flag to simulate an in-flight refresh
      (provider as any)._isRefreshing = true;

      const refreshBg = (provider as any).refreshInBackground.bind(provider);
      await refreshBg();

      // Should have bailed immediately without calling fetch or auth
      expect(mockFetch).not.toHaveBeenCalled();
      expect(authentication.getSession).not.toHaveBeenCalled();
    });
  });

  // ── Partial failures across multiple repos ──────────────────────────

  describe('partial failures across multiple repos', () => {
    it('returns issues from successful repos when some fail with HTTP errors', async () => {
      configureRepos(['good/repo', 'bad/repo']);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => null },
          json: async () => [createMockIssue(1, 'Good issue', 'good/repo')],
        })
        .mockResolvedValueOnce({ ok: false, status: 404 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('#1: Good issue');
    });

    it('shows warning listing failed repo count for user-triggered refresh', async () => {
      configureRepos(['good/repo', 'bad/repo1', 'bad/repo2']);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => null },
          json: async () => [createMockIssue(1, 'OK', 'good/repo')],
        })
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: false, status: 403 });

      await provider.refresh();

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('2 repositories'),
      );
    });

    it('shows warning with repo name when single repo fails', async () => {
      configureRepos(['good/repo', 'bad/repo']);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => null },
          json: async () => [createMockIssue(1, 'OK', 'good/repo')],
        })
        .mockResolvedValueOnce({ ok: false, status: 500 });

      await provider.refresh();

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('bad/repo'),
      );
    });

    it('returns issues from successful repos when some reject with network errors', async () => {
      configureRepos(['good/repo', 'bad/repo']);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => null },
          json: async () => [createMockIssue(1, 'Works', 'good/repo')],
        })
        .mockRejectedValueOnce(new Error('ETIMEDOUT'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('#1: Works');
    });

    it('fires event with empty items when all repos fail', async () => {
      configureRepos(['bad/repo1', 'bad/repo2']);

      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockRejectedValueOnce(new Error('Network error'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles mix of JSON parse errors and successes across repos', async () => {
      configureRepos(['good/repo', 'broken/repo']);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => null },
          json: async () => [createMockIssue(1, 'OK', 'good/repo')],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => { throw new SyntaxError('Invalid JSON'); },
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('#1: OK');
    });
  });

  // ── _isRefreshing guard (background) ────────────────────────────────

  describe('_isRefreshing guard resets after errors', () => {
    it('resets _isRefreshing after background refresh throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('kaboom'));

      const refreshBg = (provider as any).refreshInBackground.bind(provider);
      await refreshBg();

      // _isRefreshing should be false, so a second call proceeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await refreshBg();
      expect(listener).toHaveBeenCalled();
    });
  });
});
