import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, workspace, window } from 'vscode';
import { GitHubIssueProvider } from '../githubProvider';
import { GitHubSsoError } from '../githubApiHelpers';
import { setLogger } from '../logger';

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
  let mockChannel: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new GitHubIssueProvider();

    mockChannel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() };
    setLogger(mockChannel);

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

  it('propagates SSO errors during background refresh', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: (name: string) => name === 'x-github-sso' ? 'required; url=https://github.com/orgs/example-issues/sso?authorization_request=abc123' : null },
      text: async () => JSON.stringify({ message: 'Resource protected by organization SAML enforcement.' }),
    });

    await expect(provider.refreshInBackground()).rejects.toBeInstanceOf(GitHubSsoError);
  });

  it('filters out configured repos via global fetch, keeps the rest', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'filteredRepos') { return 'owner/repo1\nowner/repo2'; }
        return defaultValue;
      }),
    } as any);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        createMockIssue(1, 'Bug', 'owner/repo1'),
        createMockIssue(2, 'Feature', 'owner/repo2'),
        createMockIssue(3, 'Other', 'owner/repo3'),
      ],
      headers: { get: () => null },
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/issues?filter=assigned&state=open&per_page=100',
      expect.any(Object),
    );
    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    // Patterns filter OUT repo1 and repo2, keeping only repo3
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(expect.objectContaining({ title: '#3: Other' }));
  });

  it('ignores non-string config values (e.g. legacy array)', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'filteredRepos') { return ['owner/repo1', 'owner/repo2']; }
        return defaultValue;
      }),
    } as any);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        createMockIssue(1, 'Bug', 'owner/repo1'),
        createMockIssue(2, 'Feature', 'owner/repo2'),
      ],
      headers: { get: () => null },
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    // Non-string value is ignored — no filtering applied, all items kept
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(2);
  });

  it('falls back to /issues?filter=assigned when no repos configured', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [createMockIssue(42, 'Global issue')],
      headers: { get: () => null },
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

  it('fires onDidDiscoverItems with correctly mapped ProviderItem[]', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [createMockIssue(10, 'My issue')],
      headers: { get: () => null },
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
      reason: 'assigned',
      canonicalId: 'github:issue:owner/repo#10',
      itemType: 'issue',
      capabilities: {
        gitWork: { kind: 'issue', cloneUrl: 'https://github.com/owner/repo.git', ref: 'issue10', repoLabel: 'owner/repo' },
      },
      badges: [{ label: 'Assigned', variant: 'warning' }],
    });
  });

  it('populates author from the GitHub issue user', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{
        ...createMockIssue(11, 'Authored issue'),
        user: {
          login: 'octocat',
          avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
          html_url: 'https://github.com/octocat',
        },
      }],
      headers: { get: () => null },
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener.mock.calls[0][0][0].author).toEqual({
      displayName: 'octocat',
      handle: 'octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      profileUrl: 'https://github.com/octocat',
    });
  });

  it('should include state when issue has a state field', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{
        ...createMockIssue(5, 'Stateful issue'),
        state: 'open',
      }],
      headers: { get: () => null },
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0]).toEqual(expect.objectContaining({
      externalId: 'owner/repo#5',
      state: 'open',
    }));
  });

  it('should omit state when issue has no state field', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [createMockIssue(6, 'Stateless issue')],
      headers: { get: () => null },
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0]).not.toHaveProperty('state');
  });

  it('passes full description without truncation', async () => {
    const longBody = 'A'.repeat(300);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{
        ...createMockIssue(1, 'Long'),
        body: longBody,
      }],
      headers: { get: () => null },
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].description).toHaveLength(300);
  });

  it('handles fetch errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    // Should not throw — emits empty results on error instead of skipping emission
    await expect(provider.refresh()).resolves.toBeUndefined();
    // fetchAllAssignedIssues catches the error and returns empty, so event fires with []
    expect(listener).toHaveBeenCalledWith([]);
  });

  it('handles non-ok response gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, headers: { get: () => null } });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Should fire with empty items since the global fetch failed
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
      'Sign in',
    );
    expect(listener).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();

    const logged = mockChannel.error.mock.calls.some(
      (call: unknown[]) => String(call[0]).includes('GitHub authentication failed'),
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

    const logged = mockChannel.warn.mock.calls.some(
      (call: unknown[]) => String(call[0]).includes('background refresh'),
      );
    expect(logged).toBe(true);
  });

  it('logs info when user cancels authentication', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    await provider.refresh();

    const logged = mockChannel.info.mock.calls.some(
      (call: unknown[]) => String(call[0]).includes('User cancelled GitHub authentication'),
      );
    expect(logged).toBe(true);
  });

  it('logs debug when no session available for background refresh', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const refreshBg = (provider as any).refreshInBackground.bind(provider);
    await refreshBg();

    const logged = mockChannel.debug.mock.calls.some(
      (call: unknown[]) => String(call[0]).includes('No GitHub session available'),
      );
    expect(logged).toBe(true);
  });

  it('startPeriodicRefresh schedules a repeating timer', async () => {
    vi.useFakeTimers();

    const refreshSpy = vi.spyOn(provider as any, 'doBackgroundRefresh').mockResolvedValue();
    provider.startPeriodicRefresh(60);

    // No immediate call — only on interval
    expect(refreshSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(61_000);
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('startPeriodicRefresh does not schedule a timer for NaN or Infinity', () => {
    vi.useFakeTimers();

    const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue();

    provider.startPeriodicRefresh(NaN);
    vi.advanceTimersByTime(120_000);
    expect(refreshSpy).not.toHaveBeenCalled();

    provider.startPeriodicRefresh(Infinity);
    vi.advanceTimersByTime(120_000);
    expect(refreshSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('filters out matched repos, keeps unmatched (including invalid patterns)', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'filteredRepos') { return 'owner/valid\n../traversal\ngood/repo'; }
        return defaultValue;
      }),
    } as any);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        createMockIssue(1, 'Issue A', 'owner/valid'),
        createMockIssue(2, 'Issue B', 'good/repo'),
        createMockIssue(3, 'Issue C', 'other/repo'),
      ],
      headers: { get: () => null },
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Global fetch is always called
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    // owner/valid and good/repo are filtered out; ../traversal matches nothing; other/repo kept
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(expect.objectContaining({ title: '#3: Issue C' }));
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

  describe('URL validation in parseRepo', () => {
    it('rejects html_url from unexpected domain and falls back to repository_url', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          number: 99,
          title: 'Suspicious',
          body: 'test',
          html_url: 'https://evil.com/github.com/attacker/repo/issues/99',
          repository_url: 'https://api.github.com/repos/legit/repo',
        }],
        headers: { get: () => null },
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
        json: async () => [{
          number: 99,
          title: 'Suspicious',
          body: 'test',
          html_url: 'https://evil.com/github.com/attacker/repo/issues/99',
          repository_url: 'https://evil.com/repos/attacker/repo',
        }],
        headers: { get: () => null },
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
        json: async () => [{
          number: 50,
          title: 'Mixed',
          body: 'test',
          html_url: 'https://not-github.example.com/owner/repo/issues/50',
          repository_url: 'https://api.github.com/repos/owner/repo',
        }],
        headers: { get: () => null },
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items[0].group).toBe('owner/repo');
    });
  });

  it('paginates through multiple pages via Link header', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [createMockIssue(1, 'Page 1')],
        headers: { get: () => '<https://api.github.com/issues?page=2>; rel="next"' },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [createMockIssue(2, 'Page 2')],
        headers: { get: () => null },
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(expect.objectContaining({ title: '#1: Page 1' }));
    expect(items[1]).toEqual(expect.objectContaining({ title: '#2: Page 2' }));
  });

  it('parses Link header with multiple values (next + last)', async () => {
    const linkHeader =
      '<https://api.github.com/issues?page=2>; rel="next", ' +
      '<https://api.github.com/issues?page=5>; rel="last"';

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [createMockIssue(1, 'First')],
        headers: { get: () => linkHeader },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [createMockIssue(2, 'Second')],
        headers: { get: () => null },
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/issues?page=2',
      expect.any(Object),
    );
  });

  it('returns partial results when mid-pagination request fails', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [createMockIssue(1, 'Survived')],
        headers: { get: () => '<https://api.github.com/issues?page=2>; rel="next"' },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: { get: () => null },
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(expect.objectContaining({ title: '#1: Survived' }));

    consoleWarn.mockRestore();
  });

  it('stops paginating at maxPages limit', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 10; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [createMockIssue(i + 1, `Page ${i + 1}`)],
        headers: { get: () => `<https://api.github.com/issues?page=${i + 2}>; rel="next"` },
      });
    }

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(10);
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(10);

    consoleWarn.mockRestore();
  });

  it('returns partial results when mid-pagination network error occurs', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [createMockIssue(1, 'Survived network error')],
        headers: { get: () => '<https://api.github.com/issues?page=2>; rel="next"' },
      })
      .mockRejectedValueOnce(new Error('Network error'));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(expect.objectContaining({ title: '#1: Survived network error' }));

    consoleWarn.mockRestore();
  });

  it('does not paginate when Link header has no next rel', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [createMockIssue(1, 'Only page')],
      headers: { get: () => '<https://api.github.com/issues?page=1>; rel="prev"' },
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(1);
  });

  describe('getClosedItems', () => {
    it('returns closed issue IDs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { repository: { i0: { state: 'CLOSED' }, pr0: null, i1: { state: 'OPEN' }, pr1: null } },
        }),
      });

      const result = await provider.getClosedItems!(['owner/repo#1', 'owner/repo#2']);

      expect(result).toEqual(['owner/repo#1']);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/graphql',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
          }),
        }),
      );
      const body = JSON.parse(String(mockFetch.mock.calls[0][1].body));
      expect(body.variables).toEqual({ owner: 'owner', name: 'repo' });
      expect(body.query).toContain('i0: issue(number: 1)');
      expect(body.query).toContain('i1: issue(number: 2)');
    });

    it('returns empty array when no auth session', async () => {
      vi.mocked(authentication.getSession).mockResolvedValue(null as any);

      const result = await provider.getClosedItems!(['owner/repo#1']);

      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('ignores malformed external IDs', async () => {
      const result = await provider.getClosedItems!(['bad', 'no-hash', 'not/valid#abc']);

      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns empty array for empty input', async () => {
      const result = await provider.getClosedItems!([]);

      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('handles API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await provider.getClosedItems!(['owner/repo#1']);

      expect(result).toEqual([]);
    });
  });
});
