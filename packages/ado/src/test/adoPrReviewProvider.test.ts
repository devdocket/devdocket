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
    provider = new AdoPrReviewProvider('myorg', ['MyProject']);

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

  it('has resurfaceDismissed set to true', () => {
    expect(provider.resurfaceDismissed).toBe(true);
  });

  it('does nothing when no auth session exists', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).not.toHaveBeenCalled();
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
      externalId: 'MyProject/myrepo/101',
      title: 'PR 101: Fix bug',
      description: 'Description for PR 101',
      url: 'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/101',
      group: 'MyProject/myrepo',
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
    expect(items[0].externalId).toBe('ProjectA/repo1/1');
    expect(items[0].group).toBe('ProjectA/repo1');
    expect(items[1].externalId).toBe('ProjectA/repo2/2');
    expect(items[1].group).toBe('ProjectA/repo2');
  });

  it('truncates description to 200 chars', async () => {
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
    expect(items[0].description).toHaveLength(200);
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
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await provider.refresh();

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to determine Azure DevOps user identity'),
    );

    consoleError.mockRestore();
  });

  it('handles PR fetch failure gracefully', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-1' } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledWith([]);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch PR reviews'),
    );

    consoleError.mockRestore();
  });

  it('does not show warning for background refresh failure', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticatedUser: { id: 'user-1' } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const refreshBg = (provider as any).refreshInBackground.bind(provider);
    await refreshBg();

    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalled();

    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it('handles fetch error gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    await expect(provider.refresh()).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    consoleError.mockRestore();
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
});
