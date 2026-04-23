import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdoPRWatcher } from '../adoPRWatcher';

vi.mock('../adoAuth', () => ({
  getAdoHeaders: vi.fn().mockResolvedValue({ Accept: 'application/json', Authorization: 'Bearer mock-token' }),
  throwAdoApiError: vi.fn((response: any, label: string) => {
    throw new Error(`${label} not found`);
  }),
}));

describe('AdoPRWatcher', () => {
  let watcher: AdoPRWatcher;

  beforeEach(() => {
    watcher = new AdoPRWatcher();
    vi.restoreAllMocks();
  });

  it('has expected id and label', () => {
    expect(watcher.id).toBe('ado-pr');
    expect(watcher.label).toBe('Azure DevOps Pull Requests');
  });

  describe('canWatch', () => {
    it('returns true for valid ADO PR URL', () => {
      expect(watcher.canWatch('https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/123')).toBe(true);
    });

    it('returns true for URL with trailing slash', () => {
      expect(watcher.canWatch('https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/123/')).toBe(true);
    });

    it('returns false for non-ADO URL', () => {
      expect(watcher.canWatch('https://github.com/owner/repo/pull/42')).toBe(false);
    });

    it('returns false for ADO URL that is not a PR', () => {
      expect(watcher.canWatch('https://dev.azure.com/myorg/myproject/_build/results?buildId=123')).toBe(false);
    });

    it('returns false for invalid URL', () => {
      expect(watcher.canWatch('not-a-url')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(watcher.canWatch('')).toBe(false);
    });
  });

  describe('parsePRUrl', () => {
    const validUrl = 'https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/123';

    it('extracts org, project, repo, and prId correctly', () => {
      const result = watcher.parsePRUrl(validUrl);
      expect(result.prId).toBe('123');
    });

    it('sets providerId to ado-pr', () => {
      const result = watcher.parsePRUrl(validUrl);
      expect(result.providerId).toBe('ado-pr');
    });

    it('sets displayName to PR #123', () => {
      const result = watcher.parsePRUrl(validUrl);
      expect(result.displayName).toBe('PR #123');
    });

    it('preserves original URL', () => {
      const result = watcher.parsePRUrl(validUrl);
      expect(result.url).toBe(validUrl);
    });

    it('sets repo to org/project/repo', () => {
      const result = watcher.parsePRUrl(validUrl);
      expect(result.repo).toBe('myorg/myproject/myrepo');
    });

    it('throws for invalid URL format', () => {
      expect(() => watcher.parsePRUrl('https://dev.azure.com/myorg/myproject/_build/results?buildId=123')).toThrow('Invalid');
    });
  });

  describe('getPRRunsSnapshot', () => {
    const identifier = {
      providerId: 'ado-pr',
      prId: '42',
      displayName: 'PR #42',
      url: 'https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/42',
      repo: 'myorg/myproject/myrepo',
    };

    it('maps active PR status to open', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ pullRequestId: 42, title: 'Fix bug', status: 'active', mergeStatus: 'succeeded' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        } as Response);

      const result = await watcher.getPRRunsSnapshot(identifier);
      expect(result.prState).toBe('open');

      fetchSpy.mockRestore();
    });

    it('maps completed PR status to merged', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ pullRequestId: 42, title: 'Add feature', status: 'completed', mergeStatus: 'succeeded' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        } as Response);

      const result = await watcher.getPRRunsSnapshot(identifier);
      expect(result.prState).toBe('merged');

      fetchSpy.mockRestore();
    });

    it('maps abandoned PR status to closed', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ pullRequestId: 42, title: 'Stale PR', status: 'abandoned', mergeStatus: 'conflicts' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        } as Response);

      const result = await watcher.getPRRunsSnapshot(identifier);
      expect(result.prState).toBe('closed');

      fetchSpy.mockRestore();
    });

    it('returns displayName with PR title in snapshot', async () => {
      const id = { ...identifier };
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ pullRequestId: 42, title: 'Fix login flow', status: 'active', mergeStatus: 'succeeded' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        } as Response);

      const snapshot = await watcher.getPRRunsSnapshot(id);
      expect(snapshot.displayName).toBe('PR #42: Fix login flow');

      fetchSpy.mockRestore();
    });

    it('filters builds to only those triggered by the specific PR', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ pullRequestId: 42, title: 'My PR', status: 'active', mergeStatus: 'succeeded' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: [
              { id: 100, buildNumber: '20240101.1', definition: { name: 'CI' }, status: 'completed', result: 'succeeded', triggerInfo: { 'pr.number': '42' } },
              { id: 200, buildNumber: '20240101.2', definition: { name: 'CI' }, status: 'completed', result: 'failed', triggerInfo: { 'pr.number': '99' } },
              { id: 300, buildNumber: '20240101.3', definition: { name: 'Nightly' }, status: 'completed', result: 'succeeded', triggerInfo: {} },
            ],
          }),
        } as Response);

      const result = await watcher.getPRRunsSnapshot(identifier);
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].runId).toBe('100');
      expect(result.runs[0].displayName).toBe('CI #20240101.1');
      expect(result.runs[0].providerId).toBe('ado-pipelines');

      fetchSpy.mockRestore();
    });

    it('returns empty runs array when no builds found', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ pullRequestId: 42, title: 'Empty PR', status: 'active', mergeStatus: 'succeeded' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        } as Response);

      const result = await watcher.getPRRunsSnapshot(identifier);
      expect(result.runs).toEqual([]);

      fetchSpy.mockRestore();
    });
  });
});
