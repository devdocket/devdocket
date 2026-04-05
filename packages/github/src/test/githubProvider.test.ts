import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, window, workspace } from 'vscode';
import { GitHubIssueProvider } from '../githubProvider';
import { initLogger, LogLevel } from '../logger';

// Mock global fetch
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

describe('GitHubIssueProvider', () => {
  let provider: GitHubIssueProvider;
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new GitHubIssueProvider();

    mockChannel = { appendLine: vi.fn() };
    initLogger(mockChannel as any, LogLevel.Debug);

    // Default: auth session returns a token
    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['repo'],
      account: { id: '1', label: 'testuser' },
    } as any);

    // Default: no configured repos
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => defaultValue),
    } as any);
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  it('does nothing when no auth session exists', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches assigned issues from configured repos', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'repos') { return ['owner/repo1', 'owner/repo2']; }
        return defaultValue;
      }),
    } as any);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [createMockIssue(1, 'Bug', 'owner/repo1')],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [createMockIssue(2, 'Feature', 'owner/repo2')],
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/repos/owner/repo1/issues'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/repos/owner/repo2/issues'),
      expect.any(Object),
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ title: '#1: Bug' }),
      expect.objectContaining({ title: '#2: Feature' }),
    ]));
  });

  it('falls back to /issues?filter=assigned when no repos configured', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [createMockIssue(42, 'Global issue')],
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/issues?filter=assigned&state=open&per_page=100',
      expect.any(Object),
    );
    expect(listener).toHaveBeenCalledWith([
      expect.objectContaining({
        externalId: 'owner/repo#42',
        title: '#42: Global issue',
      }),
    ]);
  });

  it('fires onDidDiscoverItems with correctly mapped DiscoveredItem[]', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [createMockIssue(10, 'My issue')],
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      externalId: 'owner/repo#10',
      title: '#10: My issue',
      description: 'Body for issue 10',
      url: 'https://github.com/owner/repo/issues/10',
      group: 'owner/repo',
    });
  });

  it('truncates description to 200 chars', async () => {
    const longBody = 'A'.repeat(300);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{
        ...createMockIssue(1, 'Long'),
        body: longBody,
      }],
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].description).toHaveLength(200);
  });

  it('handles fetch errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    // Should not throw
    await expect(provider.refresh()).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('handles non-ok response gracefully', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'repos') { return ['owner/repo1']; }
        return defaultValue;
      }),
    } as any);

    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Should fire with empty items since the repo fetch returned empty
    expect(listener).toHaveBeenCalledWith([]);

    consoleError.mockRestore();
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

  it('startPeriodicRefresh schedules a repeating timer', () => {
    vi.useFakeTimers();

    // Spy on the private refreshInBackground method that's called by the timer
    const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue();
    provider.startPeriodicRefresh(60);

    // No immediate call — only on interval
    expect(refreshSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('stopPeriodicRefresh clears the timer', () => {
    vi.useFakeTimers();

    const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue();
    provider.startPeriodicRefresh(60);
    provider.stopPeriodicRefresh();

    vi.advanceTimersByTime(120_000);
    expect(refreshSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('dispose stops periodic refresh and disposes emitter', () => {
    vi.useFakeTimers();

    const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue();
    provider.startPeriodicRefresh(60);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    provider.dispose();

    vi.advanceTimersByTime(120_000);
    expect(refreshSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
