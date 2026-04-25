import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, workspace } from 'vscode';
import { GitHubMentionsProvider } from '../githubMentionsProvider';
import { initLogger, LogLevel } from '../logger';

const mockFetch = vi.fn();

function createMockIssue(number: number, title: string, repo = 'owner/repo') {
  return {
    number,
    title,
    body: `Body for issue ${number}`,
    state: 'open',
    html_url: `https://github.com/${repo}/issues/${number}`,
    repository_url: `https://api.github.com/repos/${repo}`,
  };
}

function createMockPr(number: number, title: string, repo = 'owner/repo') {
  return {
    number,
    title,
    body: `Body for PR ${number}`,
    state: 'open',
    html_url: `https://github.com/${repo}/pull/${number}`,
    repository_url: `https://api.github.com/repos/${repo}`,
    pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}` },
  };
}

function createMockContext(globalStateData: Record<string, unknown> = {}): any {
  const store = new Map<string, unknown>(Object.entries(globalStateData));
  return {
    globalState: {
      get: vi.fn((key: string) => store.get(key)),
      update: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    },
  };
}

describe('GitHubMentionsProvider', () => {
  let provider: GitHubMentionsProvider;
  let mockContext: ReturnType<typeof createMockContext>;
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockContext = createMockContext();
    provider = new GitHubMentionsProvider(mockContext);

    mockChannel = { appendLine: vi.fn() };
    initLogger(mockChannel as any, LogLevel.Debug);

    // Default: workspace config returns defaults (no repos configured)
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => defaultValue),
    } as any);

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

  it('has correct id and label', () => {
    expect(provider.id).toBe('github-mentions');
    expect(provider.label).toBe('GitHub Mentions');
  });

  it('discovers mentioned issues and PRs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          createMockIssue(10, 'Bug report', 'org/repo'),
          createMockPr(20, 'Fix it', 'org/repo'),
        ],
      }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(2);

    expect(items[0]).toEqual(expect.objectContaining({
      externalId: 'org/repo#10',
      title: '#10: Bug report',
      description: 'Body for issue 10',
      url: 'https://github.com/org/repo/issues/10',
      group: 'org/repo',
      reason: 'mentioned',
    }));
    expect(items[1]).toEqual(expect.objectContaining({
      externalId: 'org/repo#20',
      title: '#20: Fix it',
      url: 'https://github.com/org/repo/pull/20',
      reason: 'mentioned',
    }));
  });

  it('sets canonicalId with github:issue prefix for issues', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [createMockIssue(5, 'An issue', 'acme/lib')] }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].canonicalId).toBe('github:issue:acme/lib#5');
  });

  it('sets canonicalId with github:pull prefix for PRs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [createMockPr(8, 'A PR', 'acme/lib')] }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].canonicalId).toBe('github:pull:acme/lib#8');
  });

  it('detects isPullRequest via pull_request field', async () => {
    const issue = createMockIssue(1, 'Issue');
    const pr = createMockPr(2, 'PR');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [issue, pr] }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    // Issue should have issue prefix, PR should have pull prefix
    expect(items[0].canonicalId).toMatch(/^github:issue:/);
    expect(items[1].canonicalId).toMatch(/^github:pull:/);
  });

  it('stores activatedAt on first call and reuses it', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    await provider.refresh();
    expect(mockContext.globalState.update).toHaveBeenCalledWith(
      'mentionsActivatedAt',
      expect.any(String),
    );

    // Extract the stored timestamp
    const storedTimestamp = mockContext.globalState.update.mock.calls[0][1];
    expect(new Date(storedTimestamp).getTime()).not.toBeNaN();

    // Second refresh should reuse, not update
    mockContext.globalState.update.mockClear();
    await provider.refresh();
    expect(mockContext.globalState.update).not.toHaveBeenCalled();
  });

  it('includes activatedAt in search query', async () => {
    const timestamp = '2024-01-15T00:00:00.000Z';
    mockContext = createMockContext({ mentionsActivatedAt: timestamp });
    const localProvider = new GitHubMentionsProvider(mockContext);

    try {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      });

      const listener = vi.fn();
      localProvider.onDidDiscoverItems(listener);
      await localProvider.refresh();

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain(`updated:>${timestamp}`);
      expect(calledUrl).toContain('mentions:@me');
    } finally {
      localProvider.dispose();
    }
  });

  it('uses per-repo query when repos are configured', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'repos') { return ['org/repo1']; }
        return defaultValue;
      }),
    } as any);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [createMockIssue(1, 'Mentioned', 'org/repo1')] }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('repo:org/repo1');
  });

  it('uses all-repos query when no repos are configured', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('mentions:@me');
    expect(calledUrl).not.toContain('repo:');
  });

  it('does nothing when no auth session exists', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('handles auth failure gracefully', async () => {
    vi.mocked(authentication.getSession).mockRejectedValueOnce(
      new Error('Auth service unavailable'),
    );

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fires empty array when API returns no items', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledWith([]);
  });

  describe('getClosedItems', () => {
    it('returns empty array for empty input', async () => {
      const result = await provider.getClosedItems([]);
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('checks the issues endpoint for closed items', async () => {
      // Mock authentication for getClosedItems (uses silent session)
      vi.mocked(authentication.getSession).mockResolvedValue({
        accessToken: 'test-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      // GitHub /issues/{N} returns data for both issues and PRs
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/issues/42')) {
          return { ok: true, json: async () => ({ state: 'closed' }) };
        }
        return { ok: false, status: 404 };
      });

      const result = await provider.getClosedItems(['owner/repo#42']);
      expect(result).toContain('owner/repo#42');
      // Only the issues endpoint should be called, not pulls
      const fetchCalls = mockFetch.mock.calls.map(c => c[0] as string);
      expect(fetchCalls.some((u: string) => u.includes('/pulls/'))).toBe(false);
    });
  });

  describe('resolveUrl', () => {
    it('resolves issue URLs', async () => {
      // getHeaders uses silent auth
      vi.mocked(authentication.getSession).mockResolvedValue({
        accessToken: 'test-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          title: 'Bug report',
          body: 'Some description',
          html_url: 'https://github.com/owner/repo/issues/5',
        }),
      });

      const result = await provider.resolveUrl('https://github.com/owner/repo/issues/5');
      expect(result).toEqual({
        title: '#5: Bug report',
        notes: 'Some description',
        url: 'https://github.com/owner/repo/issues/5',
        externalId: 'owner/repo#5',
        group: 'owner/repo',
        providerId: 'github-mentions',
      });
    });

    it('resolves PR URLs', async () => {
      vi.mocked(authentication.getSession).mockResolvedValue({
        accessToken: 'test-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          title: 'Feature PR',
          body: 'PR description',
          html_url: 'https://github.com/owner/repo/pull/10',
        }),
      });

      const result = await provider.resolveUrl('https://github.com/owner/repo/pull/10');
      expect(result).toEqual({
        title: '#10: Feature PR',
        notes: 'PR description',
        url: 'https://github.com/owner/repo/pull/10',
        externalId: 'owner/repo#10',
        group: 'owner/repo',
        providerId: 'github-mentions',
      });
    });

    it('returns undefined for non-GitHub URLs', async () => {
      const result = await provider.resolveUrl('https://example.com/issue/5');
      expect(result).toBeUndefined();
    });
  });
});
