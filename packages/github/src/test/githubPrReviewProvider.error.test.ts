import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, window } from 'vscode';
import { GitHubPrReviewProvider } from '../githubPrReviewProvider';
import { setLogger } from '../logger';

const mockFetch = vi.fn();

function createMockPr(number: number, title: string, repo = 'owner/repo') {
  return {
    number,
    title,
    body: `Body for PR ${number}`,
    html_url: `https://github.com/${repo}/pull/${number}`,
    repository_url: `https://api.github.com/repos/${repo}`,
  };
}

describe('GitHubPrReviewProvider — error handling', () => {
  let provider: GitHubPrReviewProvider;
  let mockChannel: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new GitHubPrReviewProvider();

    mockChannel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() };
    setLogger(mockChannel);

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

  // ── Network errors ──────────────────────────────────────────────────

  describe('network errors', () => {
    it('handles fetch rejection (network timeout) without throwing', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network timeout'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await expect(provider.refresh()).resolves.toBeUndefined();
      expect(listener).not.toHaveBeenCalled();
    });

    it('handles TypeError from fetch (e.g. DNS failure)', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await expect(provider.refresh()).resolves.toBeUndefined();
      expect(listener).not.toHaveBeenCalled();
    });

    it('handles AbortError from fetch', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await expect(provider.refresh()).resolves.toBeUndefined();
      expect(listener).not.toHaveBeenCalled();
    });

    it('logs error on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await provider.refresh();

      expect(mockChannel.error).toHaveBeenCalled();
    });
  });

  // ── HTTP status errors ──────────────────────────────────────────────

  describe('HTTP status errors', () => {
    it('handles 401 Unauthorized without throwing', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await expect(provider.refresh()).resolves.toBeUndefined();
      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles 403 rate-limited response without throwing', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await expect(provider.refresh()).resolves.toBeUndefined();
      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles 404 Not Found without throwing', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await expect(provider.refresh()).resolves.toBeUndefined();
      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles 500 Internal Server Error without throwing', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await expect(provider.refresh()).resolves.toBeUndefined();
      expect(listener).toHaveBeenCalledWith([]);
    });

    it('shows warning for user-triggered refresh on 401', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

      await provider.refresh();

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch PR review requests'),
      );
    });

    it('shows warning for user-triggered refresh on 403', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      await provider.refresh();

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch PR review requests'),
      );
    });

    it('shows warning for user-triggered refresh on 500', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await provider.refresh();

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch PR review requests'),
      );
    });

    it('logs warning for background refresh on 401 without showing UI', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

      const refreshBg = (provider as any).refreshInBackground.bind(provider);
      await refreshBg();

      expect(window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockChannel.warn).toHaveBeenCalled();
    });

    it('logs warning for background refresh on 403 without showing UI', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      const refreshBg = (provider as any).refreshInBackground.bind(provider);
      await refreshBg();

      expect(window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockChannel.warn).toHaveBeenCalledWith('Failed to fetch PR review requests');
      expect(mockChannel.error).toHaveBeenCalledWith(expect.stringContaining('403'));
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
      expect(listener).not.toHaveBeenCalled();
    });

    it('handles empty items array in search response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles PR with missing body field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            number: 1,
            title: 'No body',
            html_url: 'https://github.com/owner/repo/pull/1',
            repository_url: 'https://api.github.com/repos/owner/repo',
            body: undefined,
          }],
        }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].description).toBeUndefined();
    });

    it('handles PR with null body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            number: 1,
            title: 'Null body',
            html_url: 'https://github.com/owner/repo/pull/1',
            repository_url: 'https://api.github.com/repos/owner/repo',
            body: null,
          }],
        }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].description).toBeUndefined();
    });

    it('handles PR with empty string body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockPr(1, 'Empty body'),
            body: '',
          }],
        }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].description).toBe('');
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

      let callCount = 0;
      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('transient failure');
        }
      });

      provider.startPeriodicRefresh(60);

      vi.advanceTimersByTime(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshSpy).toHaveBeenCalledTimes(2);
    });

    it('periodic refresh continues after auth failure', async () => {
      vi.useFakeTimers();

      let callCount = 0;
      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Auth unavailable');
        }
      });

      provider.startPeriodicRefresh(60);

      vi.advanceTimersByTime(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── _isRefreshing guard ─────────────────────────────────────────────

  describe('_isRefreshing guard', () => {
    it('does not run concurrent background refreshes', async () => {
      // Directly set the guard flag to simulate an in-flight refresh
      (provider as any)._isRefreshing = true;

      const refreshBg = (provider as any).refreshInBackground.bind(provider);
      await refreshBg();

      // Should have bailed immediately without calling fetch or auth
      expect(mockFetch).not.toHaveBeenCalled();
      expect(authentication.getSession).not.toHaveBeenCalled();
    });

    it('resets _isRefreshing after background refresh throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('kaboom'));

      const refreshBg = (provider as any).refreshInBackground.bind(provider);
      await expect(refreshBg()).rejects.toThrow('kaboom');

      // _isRefreshing should be false now, so a second call proceeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [createMockPr(1, 'PR')] }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await refreshBg();
      expect(listener).toHaveBeenCalled();
    });

    it('resets _isRefreshing after user-triggered refresh throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('kaboom'));

      await provider.refresh();

      // _isRefreshing should be false now
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [createMockPr(1, 'PR')] }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();
      expect(listener).toHaveBeenCalled();
    });
  });
});
