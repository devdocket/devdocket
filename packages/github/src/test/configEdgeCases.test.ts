import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, workspace } from 'vscode';
import { GitHubIssueProvider } from '../githubProvider';

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

describe('GitHub provider config edge cases', () => {
  let provider: GitHubIssueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new GitHubIssueProvider();

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

  describe('refreshIntervalSeconds edge cases', () => {
    it('does not start timer for zero interval', () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(0);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('does not start timer for negative interval', () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(-10);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('clamps interval below 60s up to 60s', () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(10);

      vi.advanceTimersByTime(10_000);
      expect(spy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50_000); // total 60s
      expect(spy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('NaN interval bypasses <= 0 guard (no isFinite check)', () => {
      // GitHub provider checks: if (intervalSeconds <= 0) return
      // NaN <= 0 is false, so it proceeds. Math.max(NaN, 60) = NaN
      // setInterval(fn, NaN) in Node.js fires with minimum delay
      vi.useFakeTimers();
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(NaN);
      vi.advanceTimersByTime(100);
      expect(spy.mock.calls.length).toBeGreaterThan(0);

      vi.useRealTimers();
    });
  });

  describe('repos config edge cases', () => {
    it('empty repos array falls back to global assigned issues', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/issues?filter=assigned&state=open&per_page=100',
        expect.any(Object),
      );
    });

    it('repo without slash is passed directly to API URL', async () => {
      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'repos') { return ['noslash']; }
          return defaultValue;
        }),
      } as any);

      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/repos/noslash/issues'),
        expect.any(Object),
      );
    });

    it('repo with double slash is passed directly to API URL', async () => {
      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'repos') { return ['owner//repo']; }
          return defaultValue;
        }),
      } as any);

      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/repos/owner//repo/issues'),
        expect.any(Object),
      );
    });

    it('repo with special characters is passed directly to API URL', async () => {
      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'repos') { return ['owner/repo with spaces']; }
          return defaultValue;
        }),
      } as any);

      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/repos/owner/repo with spaces/issues'),
        expect.any(Object),
      );
    });

    it('reports failure for invalid repo format', async () => {
      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'repos') { return ['badformat']; }
          return defaultValue;
        }),
      } as any);

      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Should still fire with empty items (failed repo returns empty)
      expect(listener).toHaveBeenCalledWith([]);
    });

    it('mixed valid and invalid repos fetches all and collects failures', async () => {
      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'repos') { return ['valid/repo', 'noslash']; }
          return defaultValue;
        }),
      } as any);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [createMockIssue(1, 'Good issue', 'valid/repo')],
        })
        .mockResolvedValueOnce({ ok: false, status: 404 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('#1: Good issue');
    });
  });
});
