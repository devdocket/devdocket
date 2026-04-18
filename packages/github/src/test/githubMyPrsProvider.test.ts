import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, workspace } from 'vscode';
import { GitHubMyPrsProvider, type PrDetail, type PrReview } from '../githubMyPrsProvider';
import { initLogger, LogLevel } from '../logger';

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
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new GitHubMyPrsProvider();

    mockChannel = { appendLine: vi.fn() };
    initLogger(mockChannel as any, LogLevel.Debug);

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

  it('discovers open authored PRs with status', async () => {
    const pr1 = createMockPr(1, 'Fix bug');
    const pr2 = createMockPr(2, 'Add feature');

    // Use URL-based routing because concurrent workers consume mocks in unpredictable order
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues')) {
        return mockSearchResponse([pr1, pr2]);
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

    expect(items[1].externalId).toBe('owner/repo#2');
    expect(items[1].state).toBe('Draft');
  });

  it('uses search API with repos when configured', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'repos') { return ['myorg/myrepo']; }
        return defaultValue;
      }),
    } as any);

    mockFetch.mockResolvedValueOnce(mockSearchResponse([]));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('repo:myorg/myrepo');
    expect(url).toContain('author:@me');
  });

  it('uses global search when no repos configured', async () => {
    mockFetch.mockResolvedValueOnce(mockSearchResponse([]));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('author:@me');
    expect(url).not.toContain('repo:');
  });

  it('reports failures for individual repos', async () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'repos') { return ['good/repo', 'bad/repo']; }
        return defaultValue;
      }),
    } as any);

    mockFetch
      .mockResolvedValueOnce(mockSearchResponse([]))
      .mockResolvedValueOnce(mockFailedResponse());

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toHaveLength(0);
  });

  it('falls back to Open status when PR detail fetch fails', async () => {
    const pr = createMockPr(1, 'My PR');

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues')) {
        return mockSearchResponse([pr]);
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

    mockFetch.mockResolvedValueOnce(mockSearchResponse([pr as any]));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    expect(items[0].state).toBe('Open');
  });

  it('truncates description to 200 chars', async () => {
    const pr = createMockPr(1, 'Long PR');
    pr.body = 'a'.repeat(500);

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('search/issues')) {
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
    expect(items[0].description).toHaveLength(200);
  });

  it('reports all-repos failure for global search', async () => {
    mockFetch.mockResolvedValueOnce(mockFailedResponse());

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Should still fire with empty items
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toHaveLength(0);
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

  it('ignores DISMISSED reviews', () => {
    const status = GitHubMyPrsProvider.determinePrStatus(
      { draft: false },
      [
        { user: { id: 1 }, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T00:00:00Z' },
        { user: { id: 1 }, state: 'DISMISSED', submitted_at: '2025-01-02T00:00:00Z' },
      ],
    );
    // DISMISSED doesn't override — the previous CHANGES_REQUESTED still stands
    // but since DISMISSED is filtered out, the CHANGES_REQUESTED is the latest decision
    expect(status).toBe('Changes requested');
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
});
