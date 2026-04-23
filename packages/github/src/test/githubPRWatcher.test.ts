import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubPRWatcher } from '../githubPRWatcher';

describe('GitHubPRWatcher', () => {
  let watcher: GitHubPRWatcher;

  beforeEach(() => {
    watcher = new GitHubPRWatcher();
  });

  it('has correct id and label', () => {
    expect(watcher.id).toBe('github-pr');
    expect(watcher.label).toBe('GitHub Pull Requests');
  });

  describe('canWatch', () => {
    it('returns true for valid GitHub PR URL', () => {
      expect(watcher.canWatch('https://github.com/owner/repo/pull/42')).toBe(true);
    });

    it('returns true for PR URL with trailing slash', () => {
      expect(watcher.canWatch('https://github.com/owner/repo/pull/42/')).toBe(true);
    });

    it('returns false for non-GitHub URL', () => {
      expect(watcher.canWatch('https://example.com/owner/repo/pull/42')).toBe(false);
    });

    it('returns false for GitHub URL that is not a PR', () => {
      expect(watcher.canWatch('https://github.com/owner/repo/issues/42')).toBe(false);
      expect(watcher.canWatch('https://github.com/owner/repo/actions/runs/123')).toBe(false);
    });

    it('returns false for invalid URL', () => {
      expect(watcher.canWatch('not-a-url')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(watcher.canWatch('')).toBe(false);
    });
  });

  describe('parsePRUrl', () => {
    const url = 'https://github.com/myorg/myrepo/pull/42';

    it('extracts owner, repo, and prNumber correctly', () => {
      const result = watcher.parsePRUrl(url);
      expect(result.prId).toBe('42');
      expect(result.repo).toBe('myorg/myrepo');
    });

    it('sets providerId to github-pr', () => {
      const result = watcher.parsePRUrl(url);
      expect(result.providerId).toBe('github-pr');
    });

    it('sets displayName to PR #42', () => {
      const result = watcher.parsePRUrl(url);
      expect(result.displayName).toBe('PR #42');
    });

    it('preserves original URL', () => {
      const result = watcher.parsePRUrl(url);
      expect(result.url).toBe(url);
    });

    it('sets repo to owner/repo', () => {
      const result = watcher.parsePRUrl('https://github.com/owner/repo/pull/7');
      expect(result.repo).toBe('owner/repo');
    });

    it('throws for invalid URL format', () => {
      expect(() => watcher.parsePRUrl('https://github.com/owner/repo/issues/1')).toThrow('Invalid GitHub PR URL');
    });
  });

  describe('getPRRunsSnapshot', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy?.mockRestore();
    });

    afterEach(() => {
      fetchSpy?.mockRestore();
    });

    function makeIdentifier(overrides?: Partial<{ prId: string; repo: string }>) {
      return {
        providerId: 'github-pr',
        prId: overrides?.prId ?? '42',
        displayName: 'PR #42',
        url: 'https://github.com/owner/repo/pull/42',
        repo: overrides?.repo ?? 'owner/repo',
      };
    }

    function mockFetchResponses(prData: object, checkRunsData: object) {
      fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => prData,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => checkRunsData,
        } as Response);
    }

    it('returns open state for open PR', async () => {
      mockFetchResponses(
        { number: 42, title: 'My PR', state: 'open', merged: false, head: { sha: 'abc123' } },
        { check_runs: [] },
      );

      const result = await watcher.getPRRunsSnapshot(makeIdentifier());
      expect(result.prState).toBe('open');
    });

    it('returns merged state for merged PR', async () => {
      mockFetchResponses(
        { number: 42, title: 'My PR', state: 'closed', merged: true, head: { sha: 'abc123' } },
        { check_runs: [] },
      );

      const result = await watcher.getPRRunsSnapshot(makeIdentifier());
      expect(result.prState).toBe('merged');
    });

    it('returns closed state for closed non-merged PR', async () => {
      mockFetchResponses(
        { number: 42, title: 'My PR', state: 'closed', merged: false, head: { sha: 'abc123' } },
        { check_runs: [] },
      );

      const result = await watcher.getPRRunsSnapshot(makeIdentifier());
      expect(result.prState).toBe('closed');
    });

    it('returns displayName with PR title in snapshot', async () => {
      const identifier = makeIdentifier();
      mockFetchResponses(
        { number: 42, title: 'Fix the widget', state: 'open', merged: false, head: { sha: 'abc123' } },
        { check_runs: [] },
      );

      const snapshot = await watcher.getPRRunsSnapshot(identifier);
      expect(snapshot.displayName).toBe('PR #42: Fix the widget');
    });

    it('deduplicates check runs by check_suite.id', async () => {
      mockFetchResponses(
        { number: 42, title: 'My PR', state: 'open', merged: false, head: { sha: 'abc123' } },
        {
          check_runs: [
            {
              id: 1,
              name: 'build',
              html_url: 'https://github.com/owner/repo/actions/runs/100/jobs/1',
              check_suite: { id: 500 },
            },
            {
              id: 2,
              name: 'test',
              html_url: 'https://github.com/owner/repo/actions/runs/100/jobs/2',
              check_suite: { id: 500 },
            },
          ],
        },
      );

      const result = await watcher.getPRRunsSnapshot(makeIdentifier());
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].runId).toBe('100');
    });

    it('extracts workflow run IDs from check run html_url', async () => {
      mockFetchResponses(
        { number: 42, title: 'My PR', state: 'open', merged: false, head: { sha: 'abc123' } },
        {
          check_runs: [
            {
              id: 1,
              name: 'CI',
              html_url: 'https://github.com/owner/repo/actions/runs/777/jobs/1',
              check_suite: { id: 501 },
            },
            {
              id: 2,
              name: 'Deploy',
              html_url: 'https://github.com/owner/repo/actions/runs/888/jobs/2',
              check_suite: { id: 502 },
            },
          ],
        },
      );

      const result = await watcher.getPRRunsSnapshot(makeIdentifier());
      expect(result.runs).toHaveLength(2);
      expect(result.runs[0].runId).toBe('777');
      expect(result.runs[0].displayName).toBe('CI');
      expect(result.runs[0].url).toBe('https://github.com/owner/repo/actions/runs/777');
      expect(result.runs[1].runId).toBe('888');
      expect(result.runs[1].displayName).toBe('Deploy');
    });

    it('returns empty runs array when no check runs found', async () => {
      mockFetchResponses(
        { number: 42, title: 'My PR', state: 'open', merged: false, head: { sha: 'abc123' } },
        { check_runs: [] },
      );

      const result = await watcher.getPRRunsSnapshot(makeIdentifier());
      expect(result.runs).toHaveLength(0);
    });
  });
});
