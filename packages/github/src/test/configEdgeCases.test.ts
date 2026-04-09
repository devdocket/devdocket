import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, workspace } from 'vscode';
import { GitHubIssueProvider } from '../githubProvider';
import { GitHubPrReviewProvider } from '../githubPrReviewProvider';

const mockFetch = vi.fn();

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
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not start timer for zero interval', () => {
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(0);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not start timer for negative interval', () => {
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(-10);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();
    });

    it('clamps interval below 60s up to 60s', () => {
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(10);

      vi.advanceTimersByTime(10_000);
      expect(spy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50_000); // total 60s
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not start timer for NaN interval', () => {
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(NaN);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not start timer for Infinity', () => {
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(Infinity);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();
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

    it.each([
      ['no slash', 'noslash'],
      ['double slash', 'owner//repo'],
    ])('invalid repo format (%s) is rejected before fetch with empty discovery', async (_label, repo) => {
      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'repos') { return [repo]; }
          return defaultValue;
        }),
      } as any);

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // REPO_PATTERN validation rejects invalid formats before calling fetch
      expect(mockFetch).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalledWith([]);
    });

    it.each([
      ['spaces in repo name', 'owner/repo with spaces'],
      ['valid repo with network error', 'owner/repo'],
    ])('fetch rejection (%s) is handled gracefully with empty discovery', async (_label, repo) => {
      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'repos') { return [repo]; }
          return defaultValue;
        }),
      } as any);

      mockFetch.mockRejectedValueOnce(new TypeError('Invalid URL'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });
  });
});

describe('GitHub PR review provider config edge cases', () => {
  let provider: GitHubPrReviewProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new GitHubPrReviewProvider();

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
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not start timer for zero interval', () => {
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(0);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not start timer for negative interval', () => {
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(-10);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not start timer for NaN interval', () => {
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(NaN);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not start timer for Infinity', () => {
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(Infinity);
      vi.advanceTimersByTime(120_000);
      expect(spy).not.toHaveBeenCalled();
    });

    it('clamps interval below 60s up to 60s', () => {
      const spy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      provider.startPeriodicRefresh(10);

      vi.advanceTimersByTime(10_000);
      expect(spy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50_000); // total 60s
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
