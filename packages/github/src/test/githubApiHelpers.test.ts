import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterMergedGitHubPrs, isMergedGitHubPr, type GitHubIssue } from '../githubApiHelpers';

function createIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: 'Test item',
    state: 'open',
    html_url: 'https://github.com/owner/repo/issues/1',
    repository_url: 'https://api.github.com/repos/owner/repo',
    ...overrides,
  };
}

function createPr(number: number, state: string): GitHubIssue {
  return createIssue({
    number,
    state,
    html_url: `https://github.com/owner/repo/pull/${number}`,
    pull_request: { url: `https://api.github.com/repos/owner/repo/pulls/${number}` },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isMergedGitHubPr', () => {
  it('detects merged REST PR objects from merged_at', () => {
    const item = createIssue({
      html_url: 'https://github.com/owner/repo/pull/1',
      merged_at: '2025-01-01T00:00:00Z',
    });

    expect(isMergedGitHubPr(item)).toBe(true);
  });

  it('detects merged REST PR objects from closed state and merged flag', () => {
    const item = createIssue({
      html_url: 'https://github.com/owner/repo/pull/1',
      state: 'closed',
      merged: true,
    });

    expect(isMergedGitHubPr(item)).toBe(true);
  });

  it('does not treat open PRs as merged', () => {
    const item = createIssue({
      html_url: 'https://github.com/owner/repo/pull/1',
      merged_at: null,
      merged: false,
    });

    expect(isMergedGitHubPr(item)).toBe(false);
  });

  it('does not treat closed non-merged PRs as merged', () => {
    const item = createIssue({
      html_url: 'https://github.com/owner/repo/pull/1',
      state: 'closed',
      merged: false,
    });

    expect(isMergedGitHubPr(item)).toBe(false);
  });

  it('does not treat closed issues as merged', () => {
    const item = createIssue({ state: 'closed' });

    expect(isMergedGitHubPr(item)).toBe(false);
  });
});

describe('filterMergedGitHubPrs', () => {
  it('fetches PR details for closed PR search results before filtering merged PRs', async () => {
    const openPr = createPr(1, 'open');
    const mergedPr = createPr(2, 'closed');
    const closedUnmergedPr = createPr(3, 'closed');
    const closedIssue = createIssue({ number: 4, state: 'closed' });
    const mockFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/pulls/2')) {
        return { ok: true, json: async () => ({ state: 'closed', merged: true, merged_at: '2025-01-01T00:00:00Z' }) };
      }
      if (url.endsWith('/pulls/3')) {
        return { ok: true, json: async () => ({ state: 'closed', merged: false, merged_at: null }) };
      }
      return { ok: false, status: 404, statusText: 'Not Found' };
    });
    vi.stubGlobal('fetch', mockFetch);

    const activePrs = await filterMergedGitHubPrs('test-token', [openPr, mergedPr, closedUnmergedPr, closedIssue]);

    expect(activePrs).toEqual([openPr, closedUnmergedPr, closedIssue]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.map(call => call[0])).toEqual([
      'https://api.github.com/repos/owner/repo/pulls/2',
      'https://api.github.com/repos/owner/repo/pulls/3',
    ]);
  });
});
