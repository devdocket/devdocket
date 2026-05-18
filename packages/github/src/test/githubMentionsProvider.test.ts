import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, workspace } from 'vscode';
import { GitHubMentionsProvider } from '../githubMentionsProvider';
import { setLogger } from '../logger';

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
  let mockChannel: any;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockContext = createMockContext();
    provider = new GitHubMentionsProvider(mockContext);

    mockChannel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() };
    setLogger(mockChannel);

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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function refreshWithSingleComment(commentBody: string, teams: unknown[] = [], login = 'testuser') {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => teams,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 900, body: commentBody, created_at: '2024-04-01T00:00:00Z' },
        ]),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();
    return listener.mock.calls[0][0][0];
  }

  it('has correct id and label', () => {
    expect(provider.id).toBe('github-mentions');
    expect(provider.label).toBe('GitHub Mentions');
  });

  it('requests read:org scope for team mention detection', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await provider.refresh();

    expect(authentication.getSession).toHaveBeenCalledWith('github', ['repo', 'read:org'], { createIfNone: true });
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

  it('populates author from the mentioned issue author', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            user: {
              login: 'issue-author',
              avatar_url: 'https://avatars.githubusercontent.com/u/10?v=4',
              html_url: 'https://github.com/issue-author',
            },
          }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'testuser' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener.mock.calls[0][0][0].author).toEqual({
      displayName: 'issue-author',
      handle: 'issue-author',
      avatarUrl: 'https://avatars.githubusercontent.com/u/10?v=4',
      profileUrl: 'https://github.com/issue-author',
    });
  });

  it('excludes merged PRs by fetching details for closed mentioned search results before publishing', async () => {
    const mergedPr = {
      ...createMockPr(20, 'Already merged', 'org/repo'),
      state: 'closed',
    };
    const closedIssue = { ...createMockIssue(30, 'Closed issue', 'org/repo'), state: 'closed' };

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              createMockPr(10, 'Open PR', 'org/repo'),
              mergedPr,
              closedIssue,
            ],
          }),
        };
      }
      if (url.endsWith('/pulls/20')) {
        return { ok: true, json: async () => ({ state: 'closed', merged: true, merged_at: '2025-01-01T00:00:00Z' }) };
      }
      return { ok: false, status: 404, statusText: 'Not Found' };
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items.map((item: any) => item.externalId)).toEqual(['org/repo#10', 'org/repo#30']);
    expect(items.map((item: any) => item.externalId)).not.toContain('org/repo#20');
  });

  it('fetches and attaches related items for mentioned PRs only', async () => {
    const relatedItems = [{ externalId: 'other/repo#99', itemType: 'issue' as const, relation: 'closes' as const }];
    vi.spyOn(provider as any, 'fetchRelatedItemsForPRs').mockResolvedValue(new Map([
      ['org/repo#20', relatedItems],
    ]));
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            createMockIssue(10, 'Bug report', 'org/repo'),
            createMockPr(20, 'Fix it', 'org/repo'),
            createMockPr(30, 'Needs review', 'other/project'),
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect((provider as any).fetchRelatedItemsForPRs).toHaveBeenCalledWith([
      { externalId: 'org/repo#20', repoOwner: 'org', repoName: 'repo', number: 20 },
      { externalId: 'other/project#30', repoOwner: 'other', repoName: 'project', number: 30 },
    ], 'test-token', expect.any(AbortSignal));
    const items = listener.mock.calls[0][0];
    expect(items.find((item: any) => item.externalId === 'org/repo#10')?.relatedItems).toBeUndefined();
    expect(items.find((item: any) => item.externalId === 'org/repo#20')).toEqual(expect.objectContaining({
      relatedItems,
    }));
    expect(items.find((item: any) => item.externalId === 'other/project#30')?.relatedItems).toBeUndefined();
  });

  it('sets resurfaceVersion from the latest comment that mentions the current user', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments: 2,
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 100, body: 'Initial ping @testuser', created_at: '2024-02-01T00:00:00Z', updated_at: '2024-02-05T00:00:00Z' },
          { id: 101, body: 'Follow-up without a mention', created_at: '2024-02-02T00:00:00Z' },
        ]),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].resurfaceVersion).toBe('comment:100:2024-02-01T00:00:00Z');

    const commentsFetchUrl = new URL(mockFetch.mock.calls[3][0] as string);
    expect(commentsFetchUrl.searchParams.get('per_page')).toBe('100');
    expect(commentsFetchUrl.searchParams.get('sort')).toBeNull();
    expect(commentsFetchUrl.searchParams.get('direction')).toBeNull();
  });

  it('uses newest-first initial scans when the comment count is unavailable', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 200, body: 'Newest visible ping @testuser', created_at: '2024-03-01T00:00:00Z' },
          ...Array.from({ length: 99 }, (_, i) => ({
            id: 201 + i,
            body: 'older non-mention comment',
            created_at: '2024-02-01T00:00:00Z',
          })),
        ],
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(listener.mock.calls[0][0][0].resurfaceVersion).toBe('comment:200:2024-03-01T00:00:00Z');

    const commentsFetchUrl = new URL(mockFetch.mock.calls[3][0] as string);
    expect(commentsFetchUrl.searchParams.get('sort')).toBe('created');
    expect(commentsFetchUrl.searchParams.get('direction')).toBe('desc');
  });

  it('finds a mention on a later comments page', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => Array.from({ length: 100 }, (_, i) => ({
          id: 200 + i,
          body: 'non-mention update',
          created_at: `2024-03-${String(30 - Math.floor(i / 4)).padStart(2, '0')}T00:00:00Z`,
        })),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 100, body: 'Older ping @testuser', created_at: '2024-02-01T00:00:00Z' },
        ]),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].resurfaceVersion).toBe('comment:100:2024-02-01T00:00:00Z');

    const firstPageUrl = new URL(mockFetch.mock.calls[3][0] as string);
    const secondPageUrl = new URL(mockFetch.mock.calls[4][0] as string);
    expect(firstPageUrl.searchParams.get('page')).toBe('1');
    expect(secondPageUrl.searchParams.get('page')).toBe('2');
  });

  it('stops initial backward scans after finding the newest mention', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments: 250,
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 300, body: 'Newest-page ping @testuser', created_at: '2024-03-01T00:00:00Z' },
          ...Array.from({ length: 49 }, (_, i) => ({
            id: 301 + i,
            body: 'newer non-mention comment',
            created_at: '2024-03-01T00:00:00Z',
          })),
        ],
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(listener.mock.calls[0][0][0].resurfaceVersion).toBe('comment:300:2024-03-01T00:00:00Z');
  });

  it('continues scanning backward after a partial last page', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments: 250,
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => Array.from({ length: 50 }, (_, i) => ({
          id: 300 + i,
          body: 'newer non-mention comment',
          created_at: '2024-03-01T00:00:00Z',
        })),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 200, body: 'Middle-page ping @testuser', created_at: '2024-02-01T00:00:00Z' },
          ...Array.from({ length: 99 }, (_, i) => ({
            id: 201 + i,
            body: 'middle-page non-mention comment',
            created_at: '2024-02-01T00:00:00Z',
          })),
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => Array.from({ length: 100 }, (_, i) => ({
          id: 100 + i,
          body: 'old non-mention comment',
          created_at: '2024-01-01T00:00:00Z',
        })),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].resurfaceVersion).toBe('comment:200:2024-02-01T00:00:00Z');

    const lastPageUrl = new URL(mockFetch.mock.calls[3][0] as string);
    const previousPageUrl = new URL(mockFetch.mock.calls[4][0] as string);
    expect(lastPageUrl.searchParams.get('page')).toBe('3');
    expect(previousPageUrl.searchParams.get('page')).toBe('2');
  });

  it('continues scanning backward after an empty stale last page', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments: 250,
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 200, body: 'Middle-page ping @testuser', created_at: '2024-02-01T00:00:00Z' },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => Array.from({ length: 100 }, (_, i) => ({
          id: 100 + i,
          body: 'old non-mention comment',
          created_at: '2024-01-01T00:00:00Z',
        })),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].resurfaceVersion).toBe('comment:200:2024-02-01T00:00:00Z');

    const staleLastPageUrl = new URL(mockFetch.mock.calls[3][0] as string);
    const previousPageUrl = new URL(mockFetch.mock.calls[4][0] as string);
    expect(staleLastPageUrl.searchParams.get('page')).toBe('3');
    expect(previousPageUrl.searchParams.get('page')).toBe('2');
  });

  it('changes resurfaceVersion when a later comment mentions the current user', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 100, body: 'Initial ping @testuser', created_at: '2024-02-01T00:00:00Z' },
          { id: 102, body: 'New ping @testuser', created_at: '2024-02-03T00:00:00Z' },
        ]),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].resurfaceVersion).toBe('comment:102:2024-02-03T00:00:00Z');
  });

  it('uses the authenticated GitHub login instead of the display label for mention matching', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['repo'],
      account: { id: '1', label: 'Test User' },
    } as any);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 100, body: 'Initial ping @testuser', created_at: '2024-02-01T00:00:00Z' },
        ]),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].resurfaceVersion).toBe('comment:100:2024-02-01T00:00:00Z');
  });

  it('clears cached comment versions when the authenticated login changes', async () => {
    vi.mocked(authentication.getSession)
      .mockResolvedValueOnce({
        accessToken: 'alice-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'alice' },
      } as any)
      .mockResolvedValueOnce({
        accessToken: 'bob-token',
        id: 'session-2',
        scopes: ['repo'],
        account: { id: '2', label: 'bob' },
      } as any);

    const issue = {
      ...createMockIssue(10, 'Bug report', 'org/repo'),
      comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
      updated_at: '2024-02-02T00:00:00Z',
    };

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [issue] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'alice' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 100, body: 'Initial ping @alice', created_at: '2024-02-01T00:00:00Z' },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [issue] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'bob' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 101, body: 'New ping @bob', created_at: '2024-02-03T00:00:00Z' },
        ]),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(8);
    expect(listener.mock.calls[0][0][0].resurfaceVersion).toBe('comment:100:2024-02-01T00:00:00Z');
    expect(listener.mock.calls[1][0][0].resurfaceVersion).toBe('comment:101:2024-02-03T00:00:00Z');
  });

  it('skips comment fetching when the issue has no comments', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            body: 'Original body ping @testuser',
            comments: 0,
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls[0][0][0].resurfaceVersion).toBe('issue:10');
  });

  it('uses issue body mention as a stable baseline when comments do not mention the current user', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            body: 'Original body ping @testuser',
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 101, body: 'Follow-up without a mention', created_at: '2024-02-02T00:00:00Z' },
        ]),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].resurfaceVersion).toBe('issue:10');
  });

  it('reuses cached resurfaceVersion when the issue has not changed', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
            updated_at: '2024-02-02T00:00:00Z',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 100, body: 'Initial ping @testuser', created_at: '2024-02-01T00:00:00Z' },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
            updated_at: '2024-02-02T00:00:00Z',
          }],
        }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(listener.mock.calls[1][0][0].resurfaceVersion).toBe('comment:100:2024-02-01T00:00:00Z');
  });

  it('refetches comments when issue updated_at is absent', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 100, body: 'Initial ping @testuser', created_at: '2024-02-01T00:00:00Z' },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 102, body: 'New ping @testuser', created_at: '2024-02-03T00:00:00Z' },
        ]),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(6);
    expect(listener.mock.calls[1][0][0].resurfaceVersion).toBe('comment:102:2024-02-03T00:00:00Z');

    const incrementalCommentsUrl = new URL(mockFetch.mock.calls[5][0] as string);
    expect(incrementalCommentsUrl.searchParams.get('since')).toBe('2024-02-01T00:00:00Z');
    expect(incrementalCommentsUrl.searchParams.get('sort')).toBe('created');
    expect(incrementalCommentsUrl.searchParams.get('direction')).toBe('desc');
  });

  it('stops incremental comment scans after finding the newest mention', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 100, body: 'Initial ping @testuser', created_at: '2024-02-01T00:00:00Z' },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 200, body: 'New ping @testuser', created_at: '2024-02-03T00:00:00Z' },
          ...Array.from({ length: 99 }, (_, i) => ({
            id: 201 + i,
            body: 'older non-mention update',
            created_at: '2024-02-02T00:00:00Z',
          })),
        ],
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(6);
    expect(listener.mock.calls[1][0][0].resurfaceVersion).toBe('comment:200:2024-02-03T00:00:00Z');
  });

  it('preserves cached comment versions when the search refresh fails', async () => {
    const issue = {
      ...createMockIssue(10, 'Bug report', 'org/repo'),
      comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
      updated_at: '2024-02-02T00:00:00Z',
    };

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [issue] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 100, body: 'Initial ping @testuser', created_at: '2024-02-01T00:00:00Z' },
        ]),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [issue] }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();
    await provider.refresh();
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(6);
    expect(listener.mock.calls[2][0][0].resurfaceVersion).toBe('comment:100:2024-02-01T00:00:00Z');
  });

  it('does not derive resurfaceVersion from comments that do not mention the current user', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            body: 'No mention here',
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 101, body: 'Follow-up without a mention', created_at: '2024-02-02T00:00:00Z' },
        ]),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].resurfaceVersion).toBeUndefined();
  });

  it('uses a capped comment-scan sentinel until a newer mention is found', async () => {
    const commentsUrl = 'https://api.github.com/repos/org/repo/issues/10/comments';
    const initialIssue = {
      ...createMockIssue(10, 'Bug report', 'org/repo'),
      body: 'No mention here',
      comments: 1100,
      comments_url: commentsUrl,
      updated_at: '2024-04-01T00:00:00Z',
    };
    const updatedIssue = {
      ...initialIssue,
      comments: 1101,
      updated_at: '2024-04-02T00:00:00Z',
    };

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [initialIssue] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'testuser' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    for (let page = 0; page < 10; page++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => Array.from({ length: 100 }, (_, i) => ({
          id: 1000 + (page * 100) + i,
          body: 'non-mention update',
          created_at: '2024-04-01T00:00:00Z',
        })),
      });
    }
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [updatedIssue] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 2200, body: 'New ping @testuser', created_at: '2024-04-02T00:00:00Z' },
        ]),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();
    await provider.refresh();

    expect(listener.mock.calls[0][0][0].resurfaceVersion).toBe('comments-capped:10');
    expect(listener.mock.calls[1][0][0].resurfaceVersion).toBe('comment:2200:2024-04-02T00:00:00Z');

    const firstCappedPageUrl = new URL(mockFetch.mock.calls[3][0] as string);
    const firstUpdatedPageUrl = new URL(mockFetch.mock.calls[14][0] as string);
    expect(firstCappedPageUrl.searchParams.get('page')).toBe('11');
    expect(firstUpdatedPageUrl.searchParams.get('page')).toBe('1');
    expect(firstUpdatedPageUrl.searchParams.get('since')).toBe('2024-04-01T00:00:00Z');
    expect(firstUpdatedPageUrl.searchParams.get('sort')).toBe('created');
    expect(firstUpdatedPageUrl.searchParams.get('direction')).toBe('desc');
  });

  it('counts a mention in plain prose', async () => {
    const item = await refreshWithSingleComment('Please take a look, @testuser.');

    expect(item.resurfaceVersion).toBe('comment:900:2024-04-01T00:00:00Z');
  });

  it('ignores a mention inside inline code', async () => {
    const item = await refreshWithSingleComment('This example `@testuser` should not resurface.');

    expect(item.resurfaceVersion).toBeUndefined();
  });

  it('ignores a mention inside a fenced code block', async () => {
    const item = await refreshWithSingleComment('```ts\n@testuser\n```');

    expect(item.resurfaceVersion).toBeUndefined();
  });

  it('counts a mention inside a blockquote', async () => {
    const item = await refreshWithSingleComment('> Please take a look, @testuser.');

    expect(item.resurfaceVersion).toBe('comment:900:2024-04-01T00:00:00Z');
  });

  it('counts mentions in link text but not link URLs or autolink targets', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'testuser' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 901, body: 'Display text [@testuser](https://example.com/profile)', created_at: '2024-04-01T00:00:00Z' },
          { id: 902, body: 'URL target [profile](https://example.com/@testuser)', created_at: '2024-04-02T00:00:00Z' },
          { id: 903, body: 'Autolink https://example.com/@testuser', created_at: '2024-04-03T00:00:00Z' },
        ]),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener.mock.calls[0][0][0].resurfaceVersion).toBe('comment:901:2024-04-01T00:00:00Z');
  });

  it('counts a team mention when the current user belongs to that team', async () => {
    const item = await refreshWithSingleComment('Please review, @org/platform.', [
      { slug: 'platform', organization: { login: 'org' } },
    ]);

    expect(item.resurfaceVersion).toBe('comment:900:2024-04-01T00:00:00Z');
  });

  it('ignores a team mention when the current user is not on that team', async () => {
    const item = await refreshWithSingleComment('Please review, @org/platform.', [
      { slug: 'other-team', organization: { login: 'org' } },
    ]);

    expect(item.resurfaceVersion).toBeUndefined();
  });

  it('caches team memberships across comment scans and refreshes them after the TTL', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const issueOne = {
      ...createMockIssue(10, 'First', 'org/repo'),
      comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
    };
    const issueTwo = {
      ...createMockIssue(11, 'Second', 'org/repo'),
      comments_url: 'https://api.github.com/repos/org/repo/issues/11/comments',
    };
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [issueOne, issueTwo] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'testuser' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ slug: 'platform', organization: { login: 'org' } }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 901, body: '@org/platform', created_at: '2024-04-01T00:00:00Z' }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 902, body: '@org/platform', created_at: '2024-04-02T00:00:00Z' }] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [issueOne, issueTwo] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ slug: 'platform', organization: { login: 'org' } }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 903, body: '@org/platform', created_at: '2024-04-03T00:00:00Z' }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 904, body: '@org/platform', created_at: '2024-04-04T00:00:00Z' }] });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();
    expect(mockFetch.mock.calls.filter(call => String(call[0]).includes('/user/teams'))).toHaveLength(1);

    nowSpy.mockReturnValue(1_000 + 30 * 60 * 1000 + 1);
    await provider.refresh();

    expect(mockFetch.mock.calls.filter(call => String(call[0]).includes('/user/teams'))).toHaveLength(2);
    expect(listener.mock.calls[0][0].map((item: any) => item.resurfaceVersion)).toEqual([
      'comment:901:2024-04-01T00:00:00Z',
      'comment:902:2024-04-02T00:00:00Z',
    ]);
    expect(listener.mock.calls[1][0].map((item: any) => item.resurfaceVersion)).toEqual([
      'comment:903:2024-04-03T00:00:00Z',
      'comment:904:2024-04-04T00:00:00Z',
    ]);
    nowSpy.mockRestore();
  });

  it('ignores team mentions after a team API failure but still counts user mentions', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            ...createMockIssue(10, 'Bug report', 'org/repo'),
            comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
          }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'testuser' }) })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { id: 901, body: '@testuser', created_at: '2024-04-01T00:00:00Z' },
          { id: 902, body: '@org/platform', created_at: '2024-04-02T00:00:00Z' },
        ]),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener.mock.calls[0][0][0].resurfaceVersion).toBe('comment:901:2024-04-01T00:00:00Z');
  });

  it('retries team lookup after a team API failure instead of caching the empty result', async () => {
    const issue = {
      ...createMockIssue(10, 'Bug report', 'org/repo'),
      body: 'Please review, @org/platform.',
      comments: 0,
      comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
    };
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [issue] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'testuser' }) })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [issue] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ slug: 'platform', organization: { login: 'org' } }] });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();
    await provider.refresh();

    expect(mockFetch.mock.calls.filter(call => String(call[0]).includes('/user/teams'))).toHaveLength(2);
    expect(listener.mock.calls[0][0][0].resurfaceVersion).toBeUndefined();
    expect(listener.mock.calls[1][0][0].resurfaceVersion).toBe('issue:10');
  });

  it('clears the team cache when the authenticated login changes', async () => {
    vi.mocked(authentication.getSession)
      .mockResolvedValueOnce({ accessToken: 'alice-token', id: 'session-1', scopes: ['repo', 'read:org'], account: { id: '1', label: 'alice' } } as any)
      .mockResolvedValueOnce({ accessToken: 'bob-token', id: 'session-2', scopes: ['repo', 'read:org'], account: { id: '2', label: 'bob' } } as any);

    const issue = {
      ...createMockIssue(10, 'Bug report', 'org/repo'),
      body: 'Please review, @org/platform.',
      comments: 0,
      comments_url: 'https://api.github.com/repos/org/repo/issues/10/comments',
    };
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [issue] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'alice' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ slug: 'platform', organization: { login: 'org' } }] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [issue] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'bob' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();
    await provider.refresh();

    expect(mockFetch.mock.calls.filter(call => String(call[0]).includes('/user/teams'))).toHaveLength(2);
    expect(listener.mock.calls[0][0][0].resurfaceVersion).toBe('issue:10');
    expect(listener.mock.calls[1][0][0].resurfaceVersion).toBeUndefined();
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

  it('filters results when filteredRepos patterns are configured', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'filteredRepos') { return 'org/excluded-repo'; }
        return defaultValue;
      }),
    } as any);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          createMockIssue(1, 'Included', 'org/included-repo'),
          createMockIssue(2, 'Excluded', 'org/excluded-repo'),
        ],
      }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe('org/included-repo#1');
  });

  it('passes all results when no patterns are configured', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          createMockIssue(1, 'First', 'org/repo1'),
          createMockIssue(2, 'Second', 'org/repo2'),
        ],
      }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(2);
  });

  it('negation patterns re-include previously excluded repos', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'filteredRepos') { return 'org/*\n!org/special'; }
        return defaultValue;
      }),
    } as any);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          createMockIssue(1, 'Excluded', 'org/normal'),
          createMockIssue(2, 'Re-included', 'org/special'),
          createMockIssue(3, 'Other org', 'other/repo'),
        ],
      }),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(2);
    const ids = items.map((i: any) => i.externalId);
    expect(ids).toContain('org/special#2');
    expect(ids).toContain('other/repo#3');
    expect(ids).not.toContain('org/normal#1');
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

    it('throws a specific rate-limit message (not a misleading "private repo" hint) on 403 when authenticated', async () => {
      vi.mocked(authentication.getSession).mockResolvedValue({
        accessToken: 'test-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      const headerMap = new Map<string, string>([
        ['x-ratelimit-remaining', '0'],
        ['x-ratelimit-reset', String(Math.floor(Date.now() / 1000) + 1800)],
      ]);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
        text: async () => JSON.stringify({ message: 'API rate limit exceeded for user ID 1.' }),
      });

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/issues/5'),
      ).rejects.toThrow(/rate limit exceeded/i);
    });
  });
});
