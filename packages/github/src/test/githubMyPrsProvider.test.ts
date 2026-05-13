import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, workspace } from 'vscode';
import { GitHubMyPrsProvider, type PrDetail, type PrReview } from '../githubMyPrsProvider';
import { setLogger } from '../logger';

const mockFetch = vi.fn();

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

function mockSearchResponse(items: ReturnType<typeof createMockPr>[]) {
  return {
    ok: true,
    json: async () => ({ items }),
  };
}

function mockPrDetailResponse(detail: PrDetail) {
  return {
    ok: true,
    json: async () => detail,
  };
}

function mockReviewsResponse(reviews: PrReview[]) {
  return {
    ok: true,
    json: async () => reviews,
  };
}

function mockFailedResponse(status = 500) {
  return { ok: false, status, statusText: 'Internal Server Error' };
}

describe('GitHubMyPrsProvider', () => {
  let provider: GitHubMyPrsProvider;
  let mockChannel: any;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new GitHubMyPrsProvider();
    vi.spyOn(provider as any, 'fetchRelatedItemsForPRs').mockResolvedValue(new Map());

    mockChannel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() };
    setLogger(mockChannel);

    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
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

  it('has id github-my-prs and label My GitHub PRs', () => {
    expect(provider.id).toBe('github-my-prs');
    expect(provider.label).toBe('My GitHub PRs');
  });

  it('does nothing when no auth session exists', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('excludes merged PRs by fetching details for closed authored and assigned search results', async () => {
    const openPr = createMockPr(1, 'Open PR');
    const mergedAuthoredPr = {
      ...createMockPr(2, 'Merged authored PR'),
      state: 'closed',
    };
    const mergedAssignedPr = {
      ...createMockPr(3, 'Merged assigned PR', 'other/repo'),
      state: 'closed',
    };

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues') && url.includes('author:@me')) {
        return mockSearchResponse([openPr, mergedAuthoredPr]);
      }
      if (url.includes('search/issues') && url.includes('assignee:@me')) {
        return mockSearchResponse([mergedAssignedPr]);
      }
      if (url.endsWith('/pulls/1')) {
        return mockPrDetailResponse({ draft: false });
      }
      if (url.endsWith('/pulls/1/reviews')) {
        return mockReviewsResponse([]);
      }
      if (url.endsWith('/pulls/2')) {
        return mockPrDetailResponse({ state: 'closed', merged: true, merged_at: '2025-01-01T00:00:00Z' });
      }
      if (url.endsWith('/pulls/3')) {
        return mockPrDetailResponse({ state: 'closed', merged: true, merged_at: '2025-01-02T00:00:00Z' });
      }
      return mockFailedResponse(404);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe('owner/repo#1');
    expect(items.map((item: any) => item.externalId)).not.toContain('owner/repo#2');
    expect(items.map((item: any) => item.externalId)).not.toContain('other/repo#3');
    expect((provider as any).fetchRelatedItemsForPRs).toHaveBeenCalledWith([
      { externalId: 'owner/repo#1', repoOwner: 'owner', repoName: 'repo', number: 1 },
    ], 'test-token', expect.any(AbortSignal));
  });

  it('discovers open authored PRs with status', async () => {
    const pr1 = createMockPr(1, 'Fix bug');
    const pr2 = createMockPr(2, 'Add feature');

    // Use URL-based routing because concurrent workers consume mocks in unpredictable order
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues') && url.includes('author:@me')) {
        return mockSearchResponse([pr1, pr2]);
      }
      if (url.includes('search/issues') && url.includes('assignee:@me')) {
        return mockSearchResponse([]);
      }
      if (url.endsWith('/pulls/1')) {
        return mockPrDetailResponse({ draft: false, mergeable_state: 'blocked' });
      }
      if (url.endsWith('/pulls/1/reviews')) {
        return mockReviewsResponse([]);
      }
      if (url.endsWith('/pulls/2')) {
        return mockPrDetailResponse({ draft: true });
      }
      if (url.endsWith('/pulls/2/reviews')) {
        return mockReviewsResponse([]);
      }
      return mockFailedResponse(404);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(2);

    expect(items[0].externalId).toBe('owner/repo#1');
    expect(items[0].title).toBe('#1: Fix bug');
    expect(items[0].state).toBe('Waiting on reviews');
    expect(items[0].group).toBe('owner/repo');
    expect(items[0].reason).toBe('You authored this PR');
    expect(items[0].authored).toBe(true);
    expect(items[0].canonicalId).toBe('github:pull:owner/repo#1');

    expect(items[1].externalId).toBe('owner/repo#2');
    expect(items[1].state).toBe('Draft');
    expect(items[1].reason).toBe('You authored this PR');
    expect(items[1].authored).toBe(true);
    expect(items[1].canonicalId).toBe('github:pull:owner/repo#2');
  });

  it('populates lazy gitWork for fork PRs', async () => {
    const pr = createMockPr(7, 'Fork PR');
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues') && url.includes('author:@me')) {
        return mockSearchResponse([pr]);
      }
      if (url.includes('search/issues') && url.includes('assignee:@me')) {
        return mockSearchResponse([]);
      }
      if (url.endsWith('/pulls/7/reviews')) {
        return mockReviewsResponse([]);
      }
      if (url.endsWith('/pulls/7')) {
        return {
          ok: true,
          json: async () => ({
            draft: false,
            mergeable_state: 'clean',
            head: {
              ref: 'contributor/topic',
              repo: { full_name: 'contributor/repo', clone_url: 'https://github.com/contributor/repo.git' },
            },
            base: {
              ref: 'dev',
              repo: { full_name: 'owner/repo', clone_url: 'https://github.com/owner/repo.git' },
            },
          }),
        };
      }
      return mockFailedResponse(404);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const gitWork = await listener.mock.calls[0][0][0].capabilities.gitWork();
    expect(gitWork).toEqual({
      kind: 'pr',
      cloneUrl: 'https://github.com/owner/repo.git',
      ref: 'contributor/topic',
      headCloneUrl: 'https://github.com/contributor/repo.git',
      baseRef: 'dev',
      repoLabel: 'owner/repo',
    });
  });

  it('attaches relatedItems from PR enrichment before publishing', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'filteredRepos') { return 'unrelated/repo'; }
        return defaultValue;
      }),
    } as any);
    const pr = createMockPr(1, 'Fix linked issue');
    vi.mocked((provider as any).fetchRelatedItemsForPRs).mockResolvedValue(new Map([
      ['owner/repo#1', [{ externalId: 'other/repo#99', itemType: 'issue', relation: 'closes' }]],
    ]));

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues') && url.includes('author:@me')) {
        return mockSearchResponse([pr]);
      }
      if (url.includes('search/issues') && url.includes('assignee:@me')) {
        return mockSearchResponse([]);
      }
      if (url.endsWith('/pulls/1')) {
        return mockPrDetailResponse({ draft: false });
      }
      if (url.endsWith('/pulls/1/reviews')) {
        return mockReviewsResponse([]);
      }
      return mockFailedResponse(404);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect((provider as any).fetchRelatedItemsForPRs).toHaveBeenCalledWith([
      { externalId: 'owner/repo#1', repoOwner: 'owner', repoName: 'repo', number: 1 },
    ], 'test-token', expect.any(AbortSignal));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0][0]).toEqual(expect.objectContaining({
      externalId: 'owner/repo#1',
      relatedItems: [{ externalId: 'other/repo#99', itemType: 'issue', relation: 'closes' }],
    }));
  });

  it('uses global search and filters when repos configured', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'filteredRepos') { return 'myorg/myrepo'; }
        return defaultValue;
      }),
    } as any);

    mockFetch.mockResolvedValue(mockSearchResponse([]));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // 2 calls: author:@me and assignee:@me (global, no repo: param)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const authorUrl = mockFetch.mock.calls.find((c: any[]) => c[0].includes('author:@me'))?.[0];
    expect(authorUrl).toBeDefined();
    expect(authorUrl).not.toContain('repo:');
    const assigneeUrl = mockFetch.mock.calls.find((c: any[]) => c[0].includes('assignee:@me'))?.[0];
    expect(assigneeUrl).toBeDefined();
    expect(assigneeUrl).not.toContain('repo:');
  });

  it('uses global search when no repos configured', async () => {
    mockFetch.mockResolvedValue(mockSearchResponse([]));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // 2 calls: author:@me and assignee:@me
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const authorUrl = mockFetch.mock.calls.find((c: any[]) => c[0].includes('author:@me'))?.[0];
    expect(authorUrl).toBeDefined();
    expect(authorUrl).not.toContain('repo:');
    const assigneeUrl = mockFetch.mock.calls.find((c: any[]) => c[0].includes('assignee:@me'))?.[0];
    expect(assigneeUrl).toBeDefined();
    expect(assigneeUrl).not.toContain('repo:');
  });

  it('reports failures for global fetch', async () => {
    mockFetch.mockResolvedValue(mockFailedResponse());

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Should still fire with empty items
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toHaveLength(0);
  });

  it('falls back to Open status when PR detail fetch fails', async () => {
    const pr = createMockPr(1, 'My PR');

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues') && url.includes('author:@me')) {
        return mockSearchResponse([pr]);
      }
      if (url.includes('search/issues') && url.includes('assignee:@me')) {
        return mockSearchResponse([]);
      }
      // PR detail fails
      return mockFailedResponse(404);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    expect(items[0].state).toBe('Open');
  });

  it('handles PRs without pull_request.url gracefully', async () => {
    const pr = {
      number: 1,
      title: 'No API URL',
      body: 'test',
      state: 'open',
      html_url: 'https://github.com/owner/repo/pull/1',
      repository_url: 'https://api.github.com/repos/owner/repo',
      // No pull_request field
    };

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues') && url.includes('author:@me')) {
        return mockSearchResponse([pr as any]);
      }
      if (url.includes('search/issues') && url.includes('assignee:@me')) {
        return mockSearchResponse([]);
      }
      return mockFailedResponse(404);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    expect(items[0].state).toBe('Open');
  });

  it('passes full description without truncation', async () => {
    const pr = createMockPr(1, 'Long PR');
    pr.body = 'a'.repeat(500);

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues') && url.includes('author:@me')) {
        return mockSearchResponse([pr]);
      }
      if (url.includes('search/issues') && url.includes('assignee:@me')) {
        return mockSearchResponse([]);
      }
      if (url.endsWith('/pulls/1')) {
        return mockPrDetailResponse({ draft: false });
      }
      if (url.endsWith('/pulls/1/reviews')) {
        return mockReviewsResponse([]);
      }
      return mockFailedResponse(404);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].description).toHaveLength(500);
  });

  it('reports all-repos failure for global search', async () => {
    mockFetch.mockResolvedValue(mockFailedResponse());

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Should still fire with empty items
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toHaveLength(0);
  });

  it('handles network error in global search without throwing', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Should still fire with empty items (no throw)
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toHaveLength(0);
  });

  it('discovers assigned PRs alongside authored PRs', async () => {
    const authoredPr = createMockPr(1, 'My PR');
    const assignedPr = createMockPr(2, 'Assigned to me', 'other/repo');

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues') && url.includes('author:@me')) {
        return mockSearchResponse([authoredPr]);
      }
      if (url.includes('search/issues') && url.includes('assignee:@me')) {
        return mockSearchResponse([assignedPr]);
      }
      if (url.endsWith('/pulls/1')) {
        return mockPrDetailResponse({ draft: false });
      }
      if (url.endsWith('/pulls/1/reviews')) {
        return mockReviewsResponse([]);
      }
      if (url.endsWith('/pulls/2')) {
        return mockPrDetailResponse({ draft: false });
      }
      if (url.endsWith('/pulls/2/reviews')) {
        return mockReviewsResponse([]);
      }
      return mockFailedResponse(404);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(2);

    expect(items[0].externalId).toBe('owner/repo#1');
    expect(items[0].reason).toBe('You authored this PR');
    expect(items[0].authored).toBe(true);

    expect(items[1].externalId).toBe('other/repo#2');
    expect(items[1].reason).toBe('You are assigned to this PR');
    expect(items[1].authored).toBeUndefined();
  });

  it('excludes self-authored PRs from assigned results', async () => {
    const pr = createMockPr(1, 'Both authored and assigned');

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues') && url.includes('author:@me')) {
        return mockSearchResponse([pr]);
      }
      if (url.includes('search/issues') && url.includes('assignee:@me')) {
        // Same PR also returned as assigned
        return mockSearchResponse([pr]);
      }
      if (url.endsWith('/pulls/1')) {
        return mockPrDetailResponse({ draft: false });
      }
      if (url.endsWith('/pulls/1/reviews')) {
        return mockReviewsResponse([]);
      }
      return mockFailedResponse(404);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    // Should only appear once (as authored)
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe('You authored this PR');
  });

  it('sets canonicalId on all discovered items', async () => {
    const authoredPr = createMockPr(1, 'Authored');
    const assignedPr = createMockPr(2, 'Assigned', 'org/other');

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues') && url.includes('author:@me')) {
        return mockSearchResponse([authoredPr]);
      }
      if (url.includes('search/issues') && url.includes('assignee:@me')) {
        return mockSearchResponse([assignedPr]);
      }
      if (url.includes('/pulls/')) {
        return mockPrDetailResponse({ draft: false });
      }
      if (url.includes('/reviews')) {
        return mockReviewsResponse([]);
      }
      return mockFailedResponse(404);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].canonicalId).toBe('github:pull:owner/repo#1');
    expect(items[1].canonicalId).toBe('github:pull:org/other#2');
  });

  it('handles assigned PRs API failure gracefully', async () => {
    const authoredPr = createMockPr(1, 'Authored');

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues') && url.includes('author:@me')) {
        return mockSearchResponse([authoredPr]);
      }
      if (url.includes('search/issues') && url.includes('assignee:@me')) {
        return mockFailedResponse();
      }
      if (url.endsWith('/pulls/1')) {
        return mockPrDetailResponse({ draft: false });
      }
      if (url.endsWith('/pulls/1/reviews')) {
        return mockReviewsResponse([]);
      }
      return mockFailedResponse(404);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Should still emit authored PRs even if assigned API fails
    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe('You authored this PR');
  });

  it('fetches status for assigned PRs', async () => {
    const assignedPr = createMockPr(1, 'Assigned PR');

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues') && url.includes('author:@me')) {
        return mockSearchResponse([]);
      }
      if (url.includes('search/issues') && url.includes('assignee:@me')) {
        return mockSearchResponse([assignedPr]);
      }
      if (url.endsWith('/pulls/1')) {
        return mockPrDetailResponse({ draft: false, mergeable_state: 'clean' });
      }
      if (url.endsWith('/pulls/1/reviews')) {
        return mockReviewsResponse([
          { user: { id: 10 }, state: 'APPROVED', submitted_at: '2025-01-01T00:00:00Z' },
        ]);
      }
      return mockFailedResponse(404);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe('You are assigned to this PR');
    expect(items[0].state).toBe('Ready to merge');
  });

});

describe('GitHubMyPrsProvider.determinePrStatus', () => {
  it('returns Draft for draft PRs', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: true },
      [],
    );
    expect(status).toBe('Draft');
  });

  it('returns Waiting on reviews when no reviews exist', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false },
      [],
    );
    expect(status).toBe('Waiting on reviews');
  });

  it('returns Waiting on reviews when only PENDING reviews exist', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false },
      [{ user: { id: 1 }, state: 'PENDING', submitted_at: '2025-01-01T00:00:00Z' }],
    );
    expect(status).toBe('Waiting on reviews');
  });

  it('returns Review received for COMMENTED-only reviews', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false },
      [{ user: { id: 1 }, state: 'COMMENTED', submitted_at: '2025-01-01T00:00:00Z' }],
    );
    expect(status).toBe('Review received');
  });

  it('returns Changes requested when latest review is CHANGES_REQUESTED', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false },
      [
        { user: { id: 1 }, state: 'APPROVED', submitted_at: '2025-01-01T00:00:00Z' },
        { user: { id: 1 }, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-02T00:00:00Z' },
      ],
    );
    expect(status).toBe('Changes requested');
  });

  it('returns Approved when approved but mergeable_state is not clean', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false, mergeable_state: 'blocked' },
      [{ user: { id: 1 }, state: 'APPROVED', submitted_at: '2025-01-01T00:00:00Z' }],
    );
    expect(status).toBe('Approved');
  });

  it('returns Approved when mergeable_state is undefined', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false },
      [{ user: { id: 1 }, state: 'APPROVED', submitted_at: '2025-01-01T00:00:00Z' }],
    );
    expect(status).toBe('Approved');
  });

  it('returns Ready to merge when approved and mergeable_state is clean', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false, mergeable_state: 'clean' },
      [{ user: { id: 1 }, state: 'APPROVED', submitted_at: '2025-01-01T00:00:00Z' }],
    );
    expect(status).toBe('Ready to merge');
  });

  it('uses latest review per reviewer by submitted_at', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false, mergeable_state: 'clean' },
      [
        { user: { id: 1 }, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T00:00:00Z' },
        { user: { id: 1 }, state: 'APPROVED', submitted_at: '2025-01-02T00:00:00Z' },
      ],
    );
    expect(status).toBe('Ready to merge');
  });

  it('handles multiple reviewers independently', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false, mergeable_state: 'clean' },
      [
        { user: { id: 1 }, state: 'APPROVED', submitted_at: '2025-01-01T00:00:00Z' },
        { user: { id: 2 }, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T00:00:00Z' },
      ],
    );
    // Changes requested takes priority over approved
    expect(status).toBe('Changes requested');
  });

  it('treats DISMISSED as neutralizing prior decision', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false },
      [
        { user: { id: 1 }, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T00:00:00Z' },
        { user: { id: 1 }, state: 'DISMISSED', submitted_at: '2025-01-02T00:00:00Z' },
      ],
    );
    // DISMISSED clears the reviewer's prior decision but review activity still exists
    expect(status).toBe('Review received');
  });

  it('returns Review received when only DISMISSED reviews exist', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false },
      [{ user: { id: 1 }, state: 'DISMISSED', submitted_at: '2025-01-01T00:00:00Z' }],
    );
    // DISMISSED is non-PENDING so counts as "review activity" but not a decision
    expect(status).toBe('Review received');
  });

  it('skips reviews without user ID', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false },
      [{ state: 'APPROVED', submitted_at: '2025-01-01T00:00:00Z' }],
    );
    // No user ID, so review is skipped for decision tracking but counts as activity
    expect(status).toBe('Review received');
  });

  it('draft takes priority over reviews', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: true, mergeable_state: 'clean' },
      [{ user: { id: 1 }, state: 'APPROVED', submitted_at: '2025-01-01T00:00:00Z' }],
    );
    expect(status).toBe('Draft');
  });

  it('handles reviews with missing submitted_at', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false, mergeable_state: 'clean' },
      [
        { user: { id: 1 }, state: 'CHANGES_REQUESTED' },
        { user: { id: 1 }, state: 'APPROVED', submitted_at: '2025-01-02T00:00:00Z' },
      ],
    );
    // The APPROVED review with a timestamp should override the earlier one without
    expect(status).toBe('Ready to merge');
  });
});
