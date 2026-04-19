import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubActionsWatcher } from '../githubActionsWatcher';

describe('GitHubActionsWatcher', () => {
  let watcher: GitHubActionsWatcher;

  beforeEach(() => {
    watcher = new GitHubActionsWatcher();
  });

  describe('canWatch', () => {
    it('returns true for valid GitHub Actions run URL', () => {
      expect(watcher.canWatch('https://github.com/owner/repo/actions/runs/12345')).toBe(true);
    });

    it('returns true for URL with attempt suffix', () => {
      expect(watcher.canWatch('https://github.com/owner/repo/actions/runs/12345/attempts/2')).toBe(true);
    });

    it('returns false for non-GitHub URL', () => {
      expect(watcher.canWatch('https://example.com/actions/runs/12345')).toBe(false);
    });

    it('returns false for GitHub URL without actions/runs path', () => {
      expect(watcher.canWatch('https://github.com/owner/repo/pull/1')).toBe(false);
    });

    it('returns false for invalid URL', () => {
      expect(watcher.canWatch('not-a-url')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(watcher.canWatch('')).toBe(false);
    });
  });

  describe('parseRunUrl', () => {
    it('extracts owner, repo, and runId', () => {
      const result = watcher.parseRunUrl('https://github.com/myorg/myrepo/actions/runs/999');
      expect(result.providerId).toBe('github-actions');
      expect(result.runId).toBe('999');
      expect(result.repo).toBe('myorg/myrepo');
      expect(result.url).toBe('https://github.com/myorg/myrepo/actions/runs/999');
      expect(result.displayName).toBe('CI Build');
    });

    it('throws for invalid URL format', () => {
      expect(() => watcher.parseRunUrl('https://github.com/owner/repo/pull/1')).toThrow('Invalid GitHub Actions run URL');
    });
  });

  describe('getRunStatus', () => {
    it('maps GitHub API response to RunStatus', async () => {
      const mockRunResponse = {
        id: 123,
        name: 'CI',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:10:00Z',
        run_started_at: '2026-01-01T00:00:01Z',
      };

      const mockJobsResponse = {
        jobs: [
          {
            id: 1,
            name: 'build',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-01-01T00:00:01Z',
            completed_at: '2026-01-01T00:05:00Z',
          },
          {
            id: 2,
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-01-01T00:05:00Z',
            completed_at: '2026-01-01T00:10:00Z',
          },
        ],
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockRunResponse,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockJobsResponse,
        } as Response);

      const identifier = {
        providerId: 'github-actions',
        runId: '123',
        displayName: 'CI Build',
        url: 'https://github.com/owner/repo/actions/runs/123',
        repo: 'owner/repo',
      };

      const result = await watcher.getRunStatus(identifier);

      expect(result.overallState).toBe('completed');
      expect(result.conclusion).toBe('success');
      expect(result.jobs).toHaveLength(2);
      expect(result.jobs[0].name).toBe('build');
      expect(result.jobs[1].name).toBe('test');
      expect(result.displayName).toBe('CI');

      fetchSpy.mockRestore();
    });

    it('maps in_progress status to running', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 123,
            name: 'CI',
            status: 'in_progress',
            conclusion: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:05:00Z',
            run_started_at: '2026-01-01T00:00:01Z',
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ jobs: [] }),
        } as Response);

      const identifier = {
        providerId: 'github-actions',
        runId: '123',
        displayName: 'CI Build',
        url: 'https://github.com/owner/repo/actions/runs/123',
        repo: 'owner/repo',
      };

      const result = await watcher.getRunStatus(identifier);
      expect(result.overallState).toBe('running');

      fetchSpy.mockRestore();
    });

    it('throws when repo is not set on identifier', async () => {
      const identifier = {
        providerId: 'github-actions',
        runId: '123',
        displayName: 'CI Build',
        url: 'https://github.com/owner/repo/actions/runs/123',
      };

      await expect(watcher.getRunStatus(identifier)).rejects.toThrow('Repository required');
    });

    it('throws on 404 response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
        } as Response);

      const identifier = {
        providerId: 'github-actions',
        runId: '123',
        displayName: 'CI Build',
        url: 'https://github.com/owner/repo/actions/runs/123',
        repo: 'owner/repo',
      };

      await expect(watcher.getRunStatus(identifier)).rejects.toThrow('Run not found');

      fetchSpy.mockRestore();
    });
  });
});
