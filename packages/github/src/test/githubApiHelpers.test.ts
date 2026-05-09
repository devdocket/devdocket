import { describe, expect, it } from 'vitest';
import { isMergedGitHubPr, type GitHubIssue } from '../githubApiHelpers';

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

describe('isMergedGitHubPr', () => {
  it('detects merged PR search results from pull_request.merged_at', () => {
    const item = createIssue({
      html_url: 'https://github.com/owner/repo/pull/1',
      pull_request: {
        url: 'https://api.github.com/repos/owner/repo/pulls/1',
        merged_at: '2025-01-01T00:00:00Z',
      },
    });

    expect(isMergedGitHubPr(item)).toBe(true);
  });

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
      pull_request: {
        url: 'https://api.github.com/repos/owner/repo/pulls/1',
        merged_at: null,
      },
      merged_at: null,
      merged: false,
    });

    expect(isMergedGitHubPr(item)).toBe(false);
  });

  it('does not treat closed non-merged PRs as merged', () => {
    const item = createIssue({
      html_url: 'https://github.com/owner/repo/pull/1',
      state: 'closed',
      pull_request: {
        url: 'https://api.github.com/repos/owner/repo/pulls/1',
        merged_at: null,
      },
      merged: false,
    });

    expect(isMergedGitHubPr(item)).toBe(false);
  });

  it('does not treat closed issues as merged', () => {
    const item = createIssue({ state: 'closed' });

    expect(isMergedGitHubPr(item)).toBe(false);
  });
});
