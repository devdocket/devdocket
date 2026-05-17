import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdoPipelineWatcher } from '../adoPipelineWatcher';

describe('AdoPipelineWatcher', () => {
  let watcher: AdoPipelineWatcher;

  beforeEach(() => {
    watcher = new AdoPipelineWatcher();
  });

  describe('canWatch', () => {
    it('returns true for valid ADO pipeline URL', () => {
      expect(watcher.canWatch('https://dev.azure.com/dnceng/internal/_build/results?buildId=2955324')).toBe(true);
    });

    it('returns true for URL with additional query params', () => {
      expect(watcher.canWatch('https://dev.azure.com/dnceng/internal/_build/results?buildId=123&view=results')).toBe(true);
    });

    it('returns false for non-ADO URL', () => {
      expect(watcher.canWatch('https://github.com/owner/repo/actions/runs/123')).toBe(false);
    });

    it('returns false for ADO URL without buildId', () => {
      expect(watcher.canWatch('https://dev.azure.com/dnceng/internal/_build/results')).toBe(false);
    });

    it('returns false for ADO URL with wrong path', () => {
      expect(watcher.canWatch('https://dev.azure.com/dnceng/internal/_build/definitions')).toBe(false);
    });

    it('returns false for invalid URL', () => {
      expect(watcher.canWatch('not-a-url')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(watcher.canWatch('')).toBe(false);
    });
  });

  describe('parseRunUrl', () => {
    it('extracts org, project, and buildId', () => {
      const result = watcher.parseRunUrl('https://dev.azure.com/dnceng/internal/_build/results?buildId=2955324');
      expect(result.providerId).toBe('ado-pipelines');
      expect(result.runId).toBe('2955324');
      expect(result.repo).toBe('dnceng/internal');
      expect(result.url).toBe('https://dev.azure.com/dnceng/internal/_build/results?buildId=2955324');
      expect(result.displayName).toBe('Build 2955324');
    });

    it('throws for URL without buildId', () => {
      expect(() => watcher.parseRunUrl('https://dev.azure.com/dnceng/internal/_build/results')).toThrow('Missing buildId');
    });

    it('throws for URL with wrong path', () => {
      expect(() => watcher.parseRunUrl('https://dev.azure.com/dnceng/internal/_build/definitions?buildId=123')).toThrow('Invalid');
    });
  });

  describe('getRunStatus', () => {
    it('maps ADO API response to RunStatus', async () => {
      const mockBuildResponse = {
        id: 2955324,
        buildNumber: '20240101.1',
        definition: { name: 'CI' },
        status: 'completed',
        result: 'succeeded',
        startTime: '2026-01-01T00:00:00Z',
        finishTime: '2026-01-01T00:10:00Z',
      };

      const mockTimelineResponse = {
        records: [
          { id: 'job-1', name: 'Build', type: 'Job', state: 'completed', result: 'succeeded', startTime: '2026-01-01T00:00:01Z', finishTime: '2026-01-01T00:05:00Z' },
          { id: 'job-2', name: 'Test', type: 'Job', state: 'completed', result: 'succeeded', startTime: '2026-01-01T00:05:00Z', finishTime: '2026-01-01T00:10:00Z' },
          { id: 'stage-1', name: 'Build Stage', type: 'Stage', state: 'completed', result: 'succeeded' },
        ],
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: true, json: async () => mockBuildResponse } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => mockTimelineResponse } as Response);

      const identifier = {
        providerId: 'ado-pipelines',
        runId: '2955324',
        displayName: 'Build 2955324',
        url: 'https://dev.azure.com/dnceng/internal/_build/results?buildId=2955324',
        repo: 'dnceng/internal',
      };

      const result = await watcher.getRunStatus(identifier);

      expect(result.overallState).toBe('completed');
      expect(result.conclusion).toBe('success');
      expect(result.displayName).toBe('CI #20240101.1');
      // Only Job records, not Stage
      expect(result.jobs).toHaveLength(2);
      expect(result.jobs[0].name).toBe('Build');
      expect(result.jobs[1].name).toBe('Test');

      fetchSpy.mockRestore();
    });

    it('maps partiallySucceeded builds to partial_success', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 2955325,
            buildNumber: '20240101.2',
            definition: { name: 'CI' },
            status: 'completed',
            result: 'partiallySucceeded',
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            records: [
              { id: 'job-1', name: 'Build', type: 'Job', state: 'completed', result: 'partiallySucceeded' },
            ],
          }),
        } as Response);

      const result = await watcher.getRunStatus({
        providerId: 'ado-pipelines',
        runId: '2955325',
        displayName: 'Build 2955325',
        url: 'https://dev.azure.com/dnceng/internal/_build/results?buildId=2955325',
        repo: 'dnceng/internal',
      });

      expect(result.conclusion).toBe('partial_success');
      expect(result.jobs[0].conclusion).toBe('partial_success');

      fetchSpy.mockRestore();
    });

    it('maps inProgress status to running', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 123,
            buildNumber: '1',
            definition: { name: 'CI' },
            status: 'inProgress',
            result: null,
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ records: [] }),
        } as Response);

      const identifier = {
        providerId: 'ado-pipelines',
        runId: '123',
        displayName: 'Build 123',
        url: 'https://dev.azure.com/org/proj/_build/results?buildId=123',
        repo: 'org/proj',
      };

      const result = await watcher.getRunStatus(identifier);
      expect(result.overallState).toBe('running');

      fetchSpy.mockRestore();
    });

    it('throws when repo is not set', async () => {
      const identifier = {
        providerId: 'ado-pipelines',
        runId: '123',
        displayName: 'Build 123',
        url: 'https://dev.azure.com/org/proj/_build/results?buildId=123',
      };

      await expect(watcher.getRunStatus(identifier)).rejects.toThrow('Organization/project required');
    });

    it('throws on 404 response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' } as Response);

      const identifier = {
        providerId: 'ado-pipelines',
        runId: '123',
        displayName: 'Build 123',
        url: 'https://dev.azure.com/org/proj/_build/results?buildId=123',
        repo: 'org/proj',
      };

      await expect(watcher.getRunStatus(identifier)).rejects.toThrow('not found');

      fetchSpy.mockRestore();
    });
  });
});
