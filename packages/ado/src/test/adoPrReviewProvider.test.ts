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

describe('AdoPrReviewProvider', () => {
  let provider: AdoPrReviewProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new AdoPrReviewProvider([{ org: 'myorg', projects: ['MyProject'] }]);

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

  it('has correct id and label', () => {
    expect(provider.id).toBe('ado-pr-reviews');
    expect(provider.label).toBe('Azure DevOps PR Reviews');
  });

  it('fires empty items when no auth session exists', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fires empty items when cancellation is requested before auth', async () => {
    const token = { isCancellationRequested: true } as any;

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh(token);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fires empty items when cancellation is requested after auth', async () => {
    const token = { isCancellationRequested: false } as any;
    vi.mocked(authentication.getSession).mockImplementation(async () => {
      token.isCancellationRequested = true;
      return {
        accessToken: 'test-token',
        id: 'session-1',
        scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        account: { id: '1', label: 'testuser' },
      } as any;
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh(token);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fires empty items on background refresh when no session exists', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    const refreshBg = (provider as any).refreshInBackground.bind(provider);
    await refreshBg();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches user identity then PRs for review', async () => {
    // Connection data response
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-uuid-123' } }),
      })
      // PR list response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [createMockPr(101, 'Fix bug')],
        }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call: connection data to get user ID
    expect(mockFetch).toHaveBeenCalledWith(
      'https://dev.azure.com/myorg/_apis/connectiondata',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );

    // Second call: PR list with reviewer filter
    expect(mockFetch).toHaveBeenCalledWith(
      'https://dev.azure.com/myorg/MyProject/_apis/git/pullrequests?searchCriteria.reviewerId=user-uuid-123&searchCriteria.status=active&api-version=7.1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      externalId: 'myorg/MyProject/myrepo/101',
      title: 'PR 101: Fix bug',
      description: 'Description for PR 101',
      url: 'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/101',
      group: 'MyProject/myrepo',
      reason: 'review_requested',
    });
  });

  it('caches user ID after first successful fetch', async () => {
    // First refresh: connection data + PR list
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-uuid-123' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

    await provider.refresh();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mockFetch.mockClear();

    // Second refresh: should skip connection data call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });

    await provider.refresh();
    // Only PR list call, no connection data
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('pullrequests'),
      expect.any(Object),
    );
  });

  it('invalidates cached user ID when auth account changes', async () => {
    // First refresh with account '1'
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-uuid-123' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

    await provider.refresh();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mockFetch.mockClear();

    // Switch to a different account
    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'new-token',
      id: 'session-2',
      scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      account: { id: '2', label: 'otheruser' },
    } as any);

    // Second refresh: should re-fetch connection data due to account change
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'other-user-uuid' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

    await provider.refresh();
    // Both connection data AND PR list calls
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('connectiondata'),
      expect.any(Object),
    );
  });

  it('maps multiple PRs from different repos correctly', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            createMockPr(1, 'First PR', 'ProjectA', 'repo1'),
            createMockPr(2, 'Second PR', 'ProjectA', 'repo2'),
          ],
        }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(2);
    expect(items[0].externalId).toBe('myorg/ProjectA/repo1/1');
    expect(items[0].group).toBe('ProjectA/repo1');
    expect(items[1].externalId).toBe('myorg/ProjectA/repo2/2');
    expect(items[1].group).toBe('ProjectA/repo2');
  });

  it('passes full description without truncation', async () => {
    const longDesc = 'B'.repeat(300);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ ...createMockPr(1, 'Long PR'), description: longDesc }],
        }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].description).toHaveLength(300);
  });

  it('handles undefined description gracefully', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ ...createMockPr(1, 'No desc'), description: undefined }],
        }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].description).toBeUndefined();
  });

  it('handles connection data failure gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });

    await provider.refresh();

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('user identity'),
    );
  });

  it('fires empty items and rethrows when refresh catch block is hit', async () => {
    vi.spyOn(provider as any, 'fetchAndPublishPrs').mockRejectedValue(new Error('unexpected'));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    await expect(provider.refresh()).rejects.toThrow('unexpected');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
  });

  it('fires empty items and rethrows when doBackgroundRefresh catch block is hit', async () => {
    vi.spyOn(provider as any, 'fetchAndPublishPrs').mockRejectedValue(new Error('unexpected'));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    const refreshBg = (provider as any).refreshInBackground.bind(provider);
    await expect(refreshBg()).rejects.toThrow('unexpected');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
  });

  it('handles PR fetch failure gracefully', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-1' } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledWith([]);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed to fetch from'),
    );
  });

  it('does not show warning for background refresh failure', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-1' } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const refreshBg = (provider as any).refreshInBackground.bind(provider);
    await refreshBg();

    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('handles fetch error gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    await expect(provider.refresh()).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledWith([]);
  });

  it('uses org-level PR URL when no projects are configured', async () => {
    provider.dispose();
    provider = new AdoPrReviewProvider([{ org: 'myorg', projects: [] }]);

    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      account: { id: '1', label: 'testuser' },
    } as any);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-uuid-123' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [createMockPr(42, 'Org-wide PR')],
        }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // PR request should use org-level URL (no project path segment)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://dev.azure.com/myorg/_apis/git/pullrequests?searchCriteria.reviewerId=user-uuid-123&searchCriteria.status=active&api-version=7.1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('PR 42: Org-wide PR');
  });

  it('fires empty items when no PRs found', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledWith([]);
  });

  it('startPeriodicRefresh schedules a repeating timer', () => {
    vi.useFakeTimers();

    const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
    provider.startPeriodicRefresh(60);

    expect(refreshSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('stopPeriodicRefresh clears the timer', () => {
    vi.useFakeTimers();

    const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
    provider.startPeriodicRefresh(60);
    provider.stopPeriodicRefresh();

    vi.advanceTimersByTime(120_000);
    expect(refreshSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('dispose stops periodic refresh and disposes emitter', () => {
    vi.useFakeTimers();

    const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
    provider.startPeriodicRefresh(60);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    provider.dispose();

    vi.advanceTimersByTime(120_000);
    expect(refreshSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('fires empty items when org name is invalid', async () => {
    provider.dispose();
    provider = new AdoPrReviewProvider([{ org: '../evil', projects: ['MyProject'] }]);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
  });

  it('skips invalid projects and fetches only valid ones', async () => {
    provider.dispose();
    provider = new AdoPrReviewProvider([{ org: 'myorg', projects: ['ValidProject', '../bad', 'AlsoValid'] }]);

    // Connection data + 2 valid project PR fetches
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-123' } }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // 1 connection data + 2 valid project fetches = 3
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('fires empty items when all configured projects are invalid', async () => {
    provider.dispose();
    provider = new AdoPrReviewProvider([{ org: 'myorg', projects: ['../bad', '?evil'] }]);

    // Connection data call still happens before project validation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ authenticatedUser: { id: 'user-123' } }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Only connection data fetch — no PR fetches
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
  });

  describe('getClosedItems', () => {
    it('returns completed and abandoned PR IDs', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/pullrequests/101?')) {
          return { ok: true, json: async () => ({ status: 'completed' }) };
        }
        if (url.includes('/pullrequests/102?')) {
          return { ok: true, json: async () => ({ status: 'active' }) };
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      });

      const result = await provider.getClosedItems([
        'myorg/MyProject/myrepo/101',
        'myorg/MyProject/myrepo/102',
      ]);

      expect(result).toEqual(['myorg/MyProject/myrepo/101']);
    });

    it('returns abandoned PRs', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/pullrequests/200?')) {
          return { ok: true, json: async () => ({ status: 'abandoned' }) };
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      });

      const result = await provider.getClosedItems(['myorg/MyProject/myrepo/200']);

      expect(result).toEqual(['myorg/MyProject/myrepo/200']);
    });

    it('returns empty array when no auth session', async () => {
      vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

      const result = await provider.getClosedItems(['myorg/MyProject/myrepo/101']);

      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('ignores malformed external IDs', async () => {
      const result = await provider.getClosedItems([
        'bad',
        'only/two/segments',
        'org/project/repo/abc',
        'a/b/c/d/e',
      ]);

      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns empty array for empty input', async () => {
      const result = await provider.getClosedItems([]);

      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
