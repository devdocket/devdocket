import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authentication } from 'vscode';
import { GitHubAdvancedSecurityWatcher } from '../githubAdvancedSecurityWatcher';

function makeIdentifier(overrides?: Partial<{ runId: string; repo: string }>) {
  const runId = overrides?.runId ?? '12345';
  const repo = overrides?.repo ?? 'owner/repo';
  return {
    providerId: 'github-advanced-security',
    runId,
    displayName: 'GitHub Advanced Security',
    url: `https://github.com/${repo}/runs/${runId}`,
    repo,
  };
}

function makeResponse(overrides?: Partial<Response>): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: async () => ({}),
    ...overrides,
  } as Response;
}

describe('GitHubAdvancedSecurityWatcher', () => {
  let watcher: GitHubAdvancedSecurityWatcher;
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    watcher = new GitHubAdvancedSecurityWatcher();
    vi.mocked(authentication.getSession).mockResolvedValue({ accessToken: 'mock-token' } as any);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.clearAllMocks();
  });

  it('has correct id and label', () => {
    expect(watcher.id).toBe('github-advanced-security');
    expect(watcher.label).toBe('GitHub Advanced Security');
  });

  describe('canWatch', () => {
    it('returns true for canonical GitHub check run URLs', () => {
      expect(watcher.canWatch('https://github.com/owner/repo/runs/12345')).toBe(true);
      expect(watcher.canWatch('https://github.com/owner/repo/runs/12345/')).toBe(true);
    });

    it('returns false for non-GitHub URLs', () => {
      expect(watcher.canWatch('https://example.com/owner/repo/runs/12345')).toBe(false);
    });

    it('returns false for malformed GitHub run paths', () => {
      expect(watcher.canWatch('https://github.com/owner/repo/runs/not-a-number')).toBe(false);
      expect(watcher.canWatch('https://github.com/owner/runs/12345')).toBe(false);
      expect(watcher.canWatch('https://github.com/owner/repo/runs/12345/attempts/1')).toBe(false);
    });

    it('returns false for GitHub Actions run URLs', () => {
      expect(watcher.canWatch('https://github.com/owner/repo/actions/runs/12345')).toBe(false);
    });

    it('returns false for ADO URLs', () => {
      expect(watcher.canWatch('https://dev.azure.com/org/project/_build/results?buildId=12345')).toBe(false);
    });

    it('returns false for invalid URLs', () => {
      expect(watcher.canWatch('not-a-url')).toBe(false);
      expect(watcher.canWatch('')).toBe(false);
    });
  });

  describe('parseRunUrl', () => {
    it('extracts owner, repo, and runId', () => {
      const result = watcher.parseRunUrl('https://github.com/myorg/myrepo/runs/999');

      expect(result).toEqual({
        providerId: 'github-advanced-security',
        runId: '999',
        displayName: 'GitHub Advanced Security',
        url: 'https://github.com/myorg/myrepo/runs/999',
        repo: 'myorg/myrepo',
      });
    });

    it('throws for invalid URL format', () => {
      expect(() => watcher.parseRunUrl('https://github.com/owner/repo/actions/runs/123')).toThrow(
        'Invalid GitHub Advanced Security check run URL',
      );
    });
  });

  describe('getRunStatus', () => {
    it('maps GitHub check run response to RunStatus', async () => {
      const checkRunResponse = {
        id: 12345,
        name: 'CodeQL',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-01-01T00:00:00Z',
        completed_at: '2026-01-01T00:05:00Z',
      };
      let requestSignal: AbortSignal | undefined;
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
        requestSignal = init?.signal as AbortSignal | undefined;
        return Promise.resolve(makeResponse({
          json: async () => {
            expect(requestSignal?.aborted).toBe(false);
            return checkRunResponse;
          },
        }));
      });

      const result = await watcher.getRunStatus(makeIdentifier());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.github.com/repos/owner/repo/check-runs/12345');
      expect((fetchSpy.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer mock-token');
      expect(result).toEqual({
        overallState: 'completed',
        conclusion: 'success',
        displayName: 'CodeQL',
        jobs: [{
          id: '12345',
          name: 'CodeQL',
          state: 'completed',
          conclusion: 'success',
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:05:00Z',
        }],
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:05:00Z',
      });
    });

    it('maps in_progress status to running and omits null conclusion', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({
        json: async () => ({
          id: 12345,
          name: 'Secret scanning',
          status: 'in_progress',
          conclusion: null,
          started_at: '2026-01-01T00:00:00Z',
          completed_at: null,
        }),
      }));

      const result = await watcher.getRunStatus(makeIdentifier());

      expect(result.overallState).toBe('running');
      expect(result.conclusion).toBeUndefined();
      expect(result.jobs[0].state).toBe('running');
      expect(result.jobs[0].conclusion).toBeUndefined();
      expect(result.completedAt).toBeUndefined();
    });

    it('maps waiting check run status to queued', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({
        json: async () => ({
          id: 12345,
          name: 'CodeQL',
          status: 'waiting',
          conclusion: null,
          started_at: null,
          completed_at: null,
        }),
      }));

      const result = await watcher.getRunStatus(makeIdentifier());

      expect(result.overallState).toBe('queued');
      expect(result.jobs[0].state).toBe('queued');
    });

    it('throws when repo is not set on identifier', async () => {
      const identifier = makeIdentifier();
      delete (identifier as Partial<typeof identifier>).repo;

      await expect(watcher.getRunStatus(identifier)).rejects.toThrow('Repository required');
    });

    it('throws when no GitHub auth session is available', async () => {
      vi.mocked(authentication.getSession).mockResolvedValueOnce(undefined as any);

      await expect(watcher.getRunStatus(makeIdentifier())).rejects.toThrow('No GitHub authentication session available');
    });

    it('throws on 404 response', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      }));

      await expect(watcher.getRunStatus(makeIdentifier())).rejects.toThrow('Run not found or access denied');
    });

    it('throws on 401 response', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      }));

      await expect(watcher.getRunStatus(makeIdentifier())).rejects.toThrow('GitHub authentication failed');
    });

    it('throws an auth/permission error on 403 response', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      }));

      await expect(watcher.getRunStatus(makeIdentifier())).rejects.toThrow('GitHub access denied');
    });

    it('throws a rate limit error on 403 response with exhausted rate limit', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: new Headers({ 'x-ratelimit-remaining': '0' }),
      }));

      await expect(watcher.getRunStatus(makeIdentifier())).rejects.toThrow('GitHub API rate limit exceeded');
    });

    it('throws on 500 response', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({
        ok: false,
        status: 500,
        statusText: 'Server Error',
      }));

      await expect(watcher.getRunStatus(makeIdentifier())).rejects.toThrow('GitHub API error: 500 Server Error');
    });

    it('disposes the cancellation listener after a successful request', async () => {
      const dispose = vi.fn();
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(() => ({ dispose })),
      };
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({
        json: async () => ({
          id: 12345,
          name: 'CodeQL',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-01-01T00:00:00Z',
          completed_at: '2026-01-01T00:05:00Z',
        }),
      }));

      await watcher.getRunStatus(makeIdentifier(), token as any);

      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('throws AbortError when cancelled before the request starts', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(watcher.getRunStatus(makeIdentifier(), { isCancellationRequested: true })).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws a timeout error when GitHub does not respond before the request timeout', async () => {
      vi.useFakeTimers();
      try {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }));

        const statusPromise = watcher.getRunStatus(makeIdentifier());
        const expectation = expect(statusPromise).rejects.toThrow('GitHub API request timed out after 30s');
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(30_000);

        await expectation;
      } finally {
        vi.useRealTimers();
      }
    });

    it('maps timeout-caused AbortError to the timeout message', async () => {
      vi.useFakeTimers();
      try {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
        }));

        const statusPromise = watcher.getRunStatus(makeIdentifier());
        const expectation = expect(statusPromise).rejects.toThrow('GitHub API request timed out after 30s');
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(30_000);

        await expectation;
      } finally {
        vi.useRealTimers();
      }
    });

    it('aborts an in-flight request when cancellation is requested', async () => {
      let cancellationListener: (() => void) | undefined;
      const dispose = vi.fn();
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn((listener: () => void) => {
          cancellationListener = listener;
          return { dispose };
        }),
      };

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));

      const statusPromise = watcher.getRunStatus(makeIdentifier(), token as any);
      await vi.waitFor(() => expect(token.onCancellationRequested).toHaveBeenCalledTimes(1));

      token.isCancellationRequested = true;
      cancellationListener?.();

      await expect(statusPromise).rejects.toMatchObject({ name: 'AbortError' });
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });
});
