import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, window } from 'vscode';
import { GitHubPrReviewProvider } from '../githubPrReviewProvider';
import { initLogger, LogLevel } from '../logger';

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

describe('GitHubPrReviewProvider', () => {
  let provider: GitHubPrReviewProvider;

  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new GitHubPrReviewProvider();

    mockChannel = { appendLine: vi.fn() };
    initLogger(mockChannel as any, LogLevel.Debug);

    // Default: auth session returns a token
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

  it('has id github-pr-reviews and label GitHub PR Reviews', () => {
    expect(provider.id).toBe('github-pr-reviews');
    expect(provider.label).toBe('GitHub PR Reviews');
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

  it('shows warning and logs error when auth throws on user-triggered refresh', async () => {
    vi.mocked(authentication.getSession).mockRejectedValueOnce(
      new Error('Auth service unavailable'),
    );

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed'),
    );
    expect(listener).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();

    const logged = mockChannel.appendLine.mock.calls.some(
      (call: string[]) => call[0].includes('[ERROR]') && call[0].includes('GitHub authentication failed'),
    );
    expect(logged).toBe(true);
  });

  it('does not show warning on auth failure during background refresh', async () => {
    vi.mocked(authentication.getSession).mockRejectedValueOnce(
      new Error('Network error'),
    );

    const refreshBg = (provider as any).refreshInBackground.bind(provider);
    await refreshBg();

    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();

    const logged = mockChannel.appendLine.mock.calls.some(
      (call: string[]) => call[0].includes('[WARN]') && call[0].includes('background refresh'),
    );
    expect(logged).toBe(true);
  });

  it('logs info when user cancels authentication', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    await provider.refresh();

    const logged = mockChannel.appendLine.mock.calls.some(
      (call: string[]) => call[0].includes('User cancelled GitHub authentication'),
    );
    expect(logged).toBe(true);
  });

  it('logs debug when no session available for background refresh', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const refreshBg = (provider as any).refreshInBackground.bind(provider);
    await refreshBg();

    const logged = mockChannel.appendLine.mock.calls.some(
      (call: string[]) => call[0].includes('No GitHub session available'),
    );
    expect(logged).toBe(true);
  });

  it('fetches PR reviews from search API with correct URL and headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [createMockPr(1, 'Fix bug')] }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/search/issues?q=type:pr+state:open+review-requested:@me&per_page=100',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          Accept: 'application/vnd.github+json',
        }),
      }),
    );
  });

  it('fires onDidDiscoverItems with correctly mapped DiscoveredItems', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [createMockPr(42, 'Add feature', 'org/myrepo')],
      }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      externalId: 'org/myrepo#42',
      title: '#42: Add feature',
      description: 'Body for PR 42',
      url: 'https://github.com/org/myrepo/pull/42',
      group: 'org/myrepo',
    });
  });

  it('maps multiple PRs from different repos correctly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          createMockPr(1, 'First PR', 'alpha/one'),
          createMockPr(2, 'Second PR', 'beta/two'),
        ],
      }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(2);
    expect(items[0].externalId).toBe('alpha/one#1');
    expect(items[0].group).toBe('alpha/one');
    expect(items[1].externalId).toBe('beta/two#2');
    expect(items[1].group).toBe('beta/two');
  });

  it('truncates description to 200 chars', async () => {
    const longBody = 'B'.repeat(300);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [{ ...createMockPr(1, 'Long PR'), body: longBody }],
      }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].description).toHaveLength(200);
  });

  it('handles undefined body gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [{ ...createMockPr(1, 'No body'), body: undefined }],
      }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].description).toBeUndefined();
  });

  it('handles non-ok response gracefully without crashing', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    await expect(provider.refresh()).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it('shows warning message on non-ok response for user-triggered refresh', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await provider.refresh();

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch PR review requests'),
    );
  });

  it('does not show warning on non-ok response for background refresh', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    // Call refreshInBackground via the periodic timer mechanism
    const refreshBg = (provider as any).refreshInBackground.bind(provider);
    await refreshBg();

    expect(window.showWarningMessage).not.toHaveBeenCalled();
    const logged = mockChannel.appendLine.mock.calls.some(
      (call: string[]) => call[0].includes('[WARN]'),
    );
    expect(logged).toBe(true);
  });

  it('handles fetch error gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    await expect(provider.refresh()).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    const logged = mockChannel.appendLine.mock.calls.some(
      (call: string[]) => call[0].includes('[ERROR]'),
    );
    expect(logged).toBe(true);
  });

  it('fires empty items array when search returns no results', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
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

  describe('URL validation in parseRepo', () => {
    it('rejects html_url from unexpected domain and falls back to repository_url', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            number: 99,
            title: 'Suspicious',
            body: 'test',
            html_url: 'https://evil.com/github.com/attacker/repo/pull/99',
            repository_url: 'https://api.github.com/repos/legit/repo',
          }],
        }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items[0].group).toBe('legit/repo');
    });

    it('falls back to hash when both URLs are from unexpected domains', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            number: 99,
            title: 'Suspicious',
            body: 'test',
            html_url: 'https://evil.com/github.com/attacker/repo/pull/99',
            repository_url: 'https://evil.com/repos/attacker/repo',
          }],
        }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items[0].group).toMatch(/^unknown-repo-/);
    });

    it('uses API URL fallback when html_url has unexpected domain but repository_url is valid', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            number: 50,
            title: 'Mixed',
            body: 'test',
            html_url: 'https://not-github.example.com/owner/repo/pull/50',
            repository_url: 'https://api.github.com/repos/owner/repo',
          }],
        }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items[0].group).toBe('owner/repo');
    });
  });
});
