import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, window } from 'vscode';
import { AdoPrReviewProvider } from '../adoPrReviewProvider';

const mockFetch = vi.fn();

function createMockPr(id: number, title: string, project = 'MyProject', repo = 'myrepo') {
  return {
    pullRequestId: id,
    title,
    description: `Description for PR ${id}`,
    repository: {
      name: repo,
      project: { name: project },
      webUrl: `https://dev.azure.com/myorg/${project}/_git/${repo}`,
    },
  };
}

function mockConnectionData(userId = 'user-uuid-123') {
  return {
    ok: true,
    json: async () => ({ authenticatedUser: { id: userId } }),
  };
}

function mockAuthSession(token = 'test-token', accountId = '1') {
  vi.mocked(authentication.getSession).mockResolvedValue({
    accessToken: token,
    id: 'session-1',
    scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
    account: { id: accountId, label: 'testuser' },
  } as any);
}

describe('AdoPrReviewProvider — extended', () => {
  let provider: AdoPrReviewProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    provider = new AdoPrReviewProvider([{ org: 'myorg', projects: ['MyProject'] }]);
    mockAuthSession();
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  describe('getUserId error handling', () => {
    it('clears cached user ID on network error', async () => {
      // First refresh with account '1': succeeds, caches userId
      mockFetch
        .mockResolvedValueOnce(mockConnectionData('user-1'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        })
        .mockResolvedValueOnce({ ok: false, status: 403 });

      await provider.refresh();
      expect(mockFetch).toHaveBeenCalledTimes(3);
      mockFetch.mockReset();

      // Switch account to force cache miss, then network error on connection data
      mockAuthSession('token-2', '2');
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // getUserId network error → fires empty items via warning path
      expect(listener).toHaveBeenCalledWith([]);
      mockFetch.mockReset();

      // Third refresh with same account '2': cache was cleared, should re-fetch
      mockFetch
        .mockResolvedValueOnce(mockConnectionData('user-1'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        })
        .mockResolvedValueOnce({ ok: false, status: 403 });

      await provider.refresh();
      // connection data + PR list + group membership cache attempt (cache was cleared by error)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('clears cached user ID on non-ok response', async () => {
      // First refresh with account '1': succeeds, caches userId
      mockFetch
        .mockResolvedValueOnce(mockConnectionData('user-1'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        });

      await provider.refresh();
      mockFetch.mockReset();

      // Switch account to force cache miss, connection data returns 401
      mockAuthSession('new-token', '2');
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await provider.refresh();
      mockFetch.mockReset();

      // Third refresh with same account '2': cache was cleared, should re-fetch
      mockFetch
        .mockResolvedValueOnce(mockConnectionData('user-1'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        });

      await provider.refresh();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('connectiondata'),
        expect.any(Object),
      );
    });

    it('handles malformed JSON from connection data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => { throw new SyntaxError('Unexpected token'); },
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Should fire empty items and show warning
      expect(listener).toHaveBeenCalledWith([]);
      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('user identity'),
      );
    });

    it('handles missing authenticatedUser.id in connection data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: {} }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('user identity'),
      );
    });

    it('handles null authenticatedUser in connection data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: null }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });
  });

  describe('PR fetch error handling', () => {
    it('handles malformed JSON from PR response', async () => {
      mockFetch
        .mockResolvedValueOnce(mockConnectionData())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => { throw new SyntaxError('Bad JSON'); },
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles fetch throwing on PR call', async () => {
      mockFetch
        .mockResolvedValueOnce(mockConnectionData())
        .mockRejectedValueOnce(new TypeError('Network failure'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Promise.allSettled catches, fires empty
      expect(listener).toHaveBeenCalledWith([]);
    });
  });

  describe('multiple projects', () => {
    it('fetches PRs for each configured project', async () => {
      provider.dispose();
      provider = new AdoPrReviewProvider([{ org: 'myorg', projects: ['ProjectA', 'ProjectB'] }]);
      mockAuthSession();

      mockFetch
        .mockResolvedValueOnce(mockConnectionData('user-1'))
        // ProjectA PRs
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: [createMockPr(1, 'PR in A', 'ProjectA', 'repoA')],
          }),
        })
        // ProjectB PRs
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: [createMockPr(2, 'PR in B', 'ProjectB', 'repoB')],
          }),
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(2);
      expect(items[0].group).toBe('ProjectA/repoA');
      expect(items[1].group).toBe('ProjectB/repoB');
    });

    it('reports multiple project failures', async () => {
      provider.dispose();
      provider = new AdoPrReviewProvider([{ org: 'myorg', projects: ['ProjA', 'ProjB'] }]);
      mockAuthSession();

      mockFetch
        .mockResolvedValueOnce(mockConnectionData())
        .mockResolvedValueOnce({ ok: false, status: 403 })
        .mockResolvedValueOnce({ ok: false, status: 403 });

      await provider.refresh();

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('2 sources'),
      );
    });

    it('handles mixed success and failure across projects', async () => {
      provider.dispose();
      provider = new AdoPrReviewProvider([{ org: 'myorg', projects: ['GoodProj', 'BadProj'] }]);
      mockAuthSession();

      mockFetch
        .mockResolvedValueOnce(mockConnectionData())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: [createMockPr(1, 'Good PR', 'GoodProj', 'goodrepo')],
          }),
        })
        .mockResolvedValueOnce({ ok: false, status: 500 });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].group).toBe('GoodProj/goodrepo');

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('BadProj'),
      );
    });
  });

  describe('concurrency guard', () => {
    it('skips concurrent refresh when already refreshing', async () => {
      let resolveFirst: () => void;
      const blockingPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      mockFetch.mockImplementationOnce(async () => {
        await blockingPromise;
        return mockConnectionData();
      }).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      }).mockResolvedValueOnce({ ok: false, status: 403 });

      const first = provider.refresh();
      const second = provider.refresh();

      resolveFirst!();
      await first;
      await second;

      // Only one set of fetch calls
      expect(mockFetch).toHaveBeenCalledTimes(3); // connection data + PR list + group membership cache attempt
    });
  });

  describe('URL construction', () => {
    it('URL-encodes org and project names with special characters', async () => {
      provider.dispose();
      provider = new AdoPrReviewProvider([{ org: 'my org', projects: ['My Project'] }]);
      mockAuthSession();

      mockFetch
        .mockResolvedValueOnce(mockConnectionData())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        });

      await provider.refresh();

      // Connection data URL
      const connUrl = mockFetch.mock.calls[0][0] as string;
      expect(connUrl).toContain('my%20org');

      // PR URL
      const prUrl = mockFetch.mock.calls[1][0] as string;
      expect(prUrl).toContain('my%20org');
      expect(prUrl).toContain('My%20Project');
    });

    it('includes reviewer ID and active status in PR search URL', async () => {
      mockFetch
        .mockResolvedValueOnce(mockConnectionData('reviewer-42'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        });

      await provider.refresh();

      const prUrl = mockFetch.mock.calls[1][0] as string;
      expect(prUrl).toContain('searchCriteria.reviewerId=reviewer-42');
      expect(prUrl).toContain('searchCriteria.status=active');
    });
  });

  describe('periodic refresh edge cases', () => {
    it('clamps intervals below 60 to 60 seconds', () => {
      vi.useFakeTimers();

      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
      provider.startPeriodicRefresh(30);

      vi.advanceTimersByTime(30_000);
      expect(refreshSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('does not start timer for zero interval', () => {
      vi.useFakeTimers();

      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
      provider.startPeriodicRefresh(0);

      vi.advanceTimersByTime(300_000);
      expect(refreshSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('does not start timer for negative interval', () => {
      vi.useFakeTimers();

      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
      provider.startPeriodicRefresh(-50);

      vi.advanceTimersByTime(300_000);
      expect(refreshSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('does not start timer for NaN interval', () => {
      vi.useFakeTimers();

      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
      provider.startPeriodicRefresh(NaN);

      vi.advanceTimersByTime(300_000);
      expect(refreshSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('replaces existing timer when startPeriodicRefresh called again', () => {
      vi.useFakeTimers();

      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
      provider.startPeriodicRefresh(60);
      provider.startPeriodicRefresh(120);

      vi.advanceTimersByTime(60_000);
      expect(refreshSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  describe('background refresh', () => {
    it('uses createIfNone: false for background refresh', async () => {
      mockFetch
        .mockResolvedValueOnce(mockConnectionData())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        });

      const refreshBg = (provider as any).refreshInBackground.bind(provider);
      await refreshBg();

      expect(authentication.getSession).toHaveBeenCalledWith(
        'microsoft',
        ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        { createIfNone: false },
      );
    });

    it('uses createIfNone: true for user-triggered refresh', async () => {
      mockFetch
        .mockResolvedValueOnce(mockConnectionData())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        });

      await provider.refresh();

      expect(authentication.getSession).toHaveBeenCalledWith(
        'microsoft',
        ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        { createIfNone: true },
      );
    });
  });

  describe('resurfacing configuration', () => {
    afterEach(async () => {
      const { workspace } = await import('vscode');
      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
      } as any);
    });

    it('omits resurfaceVersion when resurfaceOnNewVersion is false', async () => {
      const { workspace } = await import('vscode');
      vi.mocked(workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'resurfaceOnNewVersion') {
            return false;
          }
          return defaultValue;
        }),
      } as any);

      const prWithCommit = {
        ...createMockPr(1, 'PR with commit'),
        lastMergeSourceCommit: { commitId: 'abc123' },
      };

      mockFetch
        .mockResolvedValueOnce(mockConnectionData())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [prWithCommit] }),
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].resurfaceVersion).toBeUndefined();
    });

    it('includes resurfaceVersion when resurfaceOnNewVersion is true (default)', async () => {
      const prWithCommit = {
        ...createMockPr(1, 'PR with commit'),
        lastMergeSourceCommit: { commitId: 'abc123' },
      };

      mockFetch
        .mockResolvedValueOnce(mockConnectionData())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [prWithCommit] }),
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].resurfaceVersion).toBe('abc123');
    });
  });

  describe('PR URL construction in results', () => {
    it('constructs URL from org/project/repo when webUrl is undefined', async () => {
      const prWithoutWebUrl = {
        pullRequestId: 99,
        title: 'No webUrl PR',
        description: 'A PR without webUrl',
        repository: {
          name: 'myrepo',
          project: { name: 'MyProject' },
        },
      };

      mockFetch
        .mockResolvedValueOnce(mockConnectionData())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [prWithoutWebUrl] }),
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items[0].url).toBe('https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/99');
    });

    it('constructs correct PR URL from repository webUrl', async () => {
      mockFetch
        .mockResolvedValueOnce(mockConnectionData())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: [createMockPr(42, 'My PR', 'TestProj', 'myrepo')],
          }),
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items[0].url).toBe('https://dev.azure.com/myorg/TestProj/_git/myrepo/pullrequest/42');
    });
  });
});
