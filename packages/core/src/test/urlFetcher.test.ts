import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authentication } from 'vscode';
import { fetchItemDetails } from '../services/urlFetcher';
import type { ParsedUrl } from '../services/urlParser';

vi.mock('../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Store original fetch so we can restore it
const originalFetch = globalThis.fetch;

describe('fetchItemDetails', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('GitHub PR', () => {
    const parsed: ParsedUrl = { type: 'github-pr', owner: 'octocat', repo: 'hello', number: 42 };

    it('returns details on successful fetch', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'Fix bug', body: 'Some description', html_url: 'https://github.com/octocat/hello/pull/42' }),
      });

      const result = await fetchItemDetails(parsed);
      expect(result).toEqual({
        title: 'Fix bug',
        notes: 'Some description',
        url: 'https://github.com/octocat/hello/pull/42',
        externalId: 'octocat/hello#42',
        group: 'octocat/hello',
        providerId: 'github-pr-reviews',
      });
    });

    it('uses empty string for null body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'No body', body: null, html_url: 'https://github.com/octocat/hello/pull/42' }),
      });

      const result = await fetchItemDetails(parsed);
      expect(result.notes).toBe('');
    });

    it('throws on 404', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
      await expect(fetchItemDetails(parsed)).rejects.toThrow(/not found/i);
    });

    it('throws with auth message on 403', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
      await expect(fetchItemDetails(parsed)).rejects.toThrow(/access denied/i);
    });

    it('throws with auth message on 401', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
      await expect(fetchItemDetails(parsed)).rejects.toThrow(/access denied/i);
    });

    it('throws generic error on other status codes', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
      await expect(fetchItemDetails(parsed)).rejects.toThrow(/GitHub API error: 500/);
    });

    it('passes abort signal to fetch', async () => {
      const controller = new AbortController();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'T', body: null, html_url: 'https://github.com/o/r/pull/1' }),
      });

      await fetchItemDetails(parsed, controller.signal);
      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
    });

    it('includes auth token in request when session is available', async () => {
      vi.mocked(authentication.getSession).mockResolvedValue({
        accessToken: 'gh-token-123',
        id: 'test',
        account: { id: '1', label: 'user' },
        scopes: ['repo'],
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'T', body: null, html_url: 'https://github.com/o/r/pull/1' }),
      });

      await fetchItemDetails(parsed);
      expect(authentication.getSession).toHaveBeenCalledWith('github', ['repo'], { silent: true });
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer gh-token-123');
    });

    it('omits auth header when no session is available', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'T', body: null, html_url: 'https://github.com/o/r/pull/1' }),
      });

      await fetchItemDetails(parsed);
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('falls back to unauthenticated when getSession throws', async () => {
      vi.mocked(authentication.getSession).mockRejectedValue(new Error('auth unavailable'));
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'T', body: null, html_url: 'https://github.com/o/r/pull/1' }),
      });

      await fetchItemDetails(parsed);
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('retries with interactive auth on 404 and succeeds', async () => {
      // First call: silent auth returns no session, fetch returns 404
      // Second call: interactive auth returns a session, retry fetch succeeds
      vi.mocked(authentication.getSession)
        .mockResolvedValueOnce(undefined as any) // silent auth — no session
        .mockResolvedValueOnce({
          accessToken: 'interactive-token',
          id: 'test',
          account: { id: '1', label: 'user' },
          scopes: ['repo'],
        });
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ title: 'Private PR', body: 'secret', html_url: 'https://github.com/octocat/hello/pull/42' }),
        });

      const result = await fetchItemDetails(parsed);
      expect(result.title).toBe('Private PR');
      expect(result.notes).toBe('secret');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Second fetch should have the interactive auth token
      const retryHeaders = mockFetch.mock.calls[1][1].headers;
      expect(retryHeaders['Authorization']).toBe('Bearer interactive-token');
    });

    it('skips auth retry when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      vi.mocked(authentication.getSession)
        .mockResolvedValueOnce(undefined as any)
        .mockResolvedValueOnce({
          accessToken: 'should-not-use',
          id: 'test',
          account: { id: '1', label: 'user' },
          scopes: ['repo'],
        });
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      await expect(fetchItemDetails(parsed, controller.signal)).rejects.toThrow(/not found/i);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // Silent auth is called once; interactive auth (createIfNone) should never be called
      expect(authentication.getSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('ADO PR', () => {
    const parsed: ParsedUrl = { type: 'ado-pr', org: 'myorg', project: 'myproj', repo: 'myrepo', id: 7 };

    it('returns details on successful fetch', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'ADO fix', description: 'ADO desc', repository: { name: 'myrepo', project: { name: 'myproj' } } }),
      });

      const result = await fetchItemDetails(parsed);
      expect(result).toEqual({
        title: 'ADO fix',
        notes: 'ADO desc',
        url: 'https://dev.azure.com/myorg/myproj/_git/myrepo/pullrequest/7',
        externalId: 'myorg/myproj/myrepo/7',
        group: 'myorg/myproj',
        providerId: 'ado-pr-reviews',
      });
    });

    it('uses empty string for null description', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'No desc', description: null, repository: { name: 'myrepo', project: { name: 'myproj' } } }),
      });

      const result = await fetchItemDetails(parsed);
      expect(result.notes).toBe('');
    });

    it('uses canonical names from API for externalId', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'PR', description: null, repository: { name: 'MyRepo', project: { name: 'My Project' } } }),
      });

      const result = await fetchItemDetails(parsed);
      expect(result.externalId).toBe('myorg/My Project/MyRepo/7');
      expect(result.group).toBe('myorg/My Project');
    });

    it('throws on 404', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
      await expect(fetchItemDetails(parsed)).rejects.toThrow(/not found/i);
    });

    it('throws with auth message on 401', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
      await expect(fetchItemDetails(parsed)).rejects.toThrow(/authentication required/i);
    });

    it('throws with auth message on 403', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
      await expect(fetchItemDetails(parsed)).rejects.toThrow(/authentication required/i);
    });

    it('includes auth token in request when session is available', async () => {
      vi.mocked(authentication.getSession).mockResolvedValue({
        accessToken: 'ado-token-456',
        id: 'test',
        account: { id: '1', label: 'user' },
        scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'T', description: null, repository: { name: 'myrepo', project: { name: 'myproj' } } }),
      });

      await fetchItemDetails(parsed);
      expect(authentication.getSession).toHaveBeenCalledWith(
        'microsoft',
        ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        { silent: true },
      );
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer ado-token-456');
    });

    it('omits auth header when no session is available', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'T', description: null, repository: { name: 'myrepo', project: { name: 'myproj' } } }),
      });

      await fetchItemDetails(parsed);
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('falls back to unauthenticated when getSession throws', async () => {
      vi.mocked(authentication.getSession).mockRejectedValue(new Error('auth unavailable'));
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'T', description: null, repository: { name: 'myrepo', project: { name: 'myproj' } } }),
      });

      await fetchItemDetails(parsed);
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('retries with interactive auth on 404 and succeeds', async () => {
      vi.mocked(authentication.getSession)
        .mockResolvedValueOnce(undefined as any) // silent auth — no session
        .mockResolvedValueOnce({
          accessToken: 'ado-interactive-token',
          id: 'test',
          account: { id: '1', label: 'user' },
          scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        });
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ title: 'Private ADO PR', description: 'secret ado', repository: { name: 'myrepo', project: { name: 'myproj' } } }),
        });

      const result = await fetchItemDetails(parsed);
      expect(result.title).toBe('Private ADO PR');
      expect(result.notes).toBe('secret ado');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const retryHeaders = mockFetch.mock.calls[1][1].headers;
      expect(retryHeaders['Authorization']).toBe('Bearer ado-interactive-token');
    });

    it('skips auth retry when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      vi.mocked(authentication.getSession)
        .mockResolvedValueOnce(undefined as any)
        .mockResolvedValueOnce({
          accessToken: 'should-not-use',
          id: 'test',
          account: { id: '1', label: 'user' },
          scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        });
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      await expect(fetchItemDetails(parsed, controller.signal)).rejects.toThrow(/not found/i);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(authentication.getSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('GitHub Issue', () => {
    const parsed: ParsedUrl = { type: 'github-issue', owner: 'octocat', repo: 'hello', number: 10 };

    it('returns details on successful fetch', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'Bug report', body: 'Steps to reproduce', html_url: 'https://github.com/octocat/hello/issues/10' }),
      });

      const result = await fetchItemDetails(parsed);
      expect(result).toEqual({
        title: 'Bug report',
        notes: 'Steps to reproduce',
        url: 'https://github.com/octocat/hello/issues/10',
        externalId: 'octocat/hello#10',
        group: 'octocat/hello',
        providerId: 'github',
      });
    });

    it('uses empty string for null body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'No body', body: null, html_url: 'https://github.com/octocat/hello/issues/10' }),
      });

      const result = await fetchItemDetails(parsed);
      expect(result.notes).toBe('');
    });

    it('throws on 404', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
      await expect(fetchItemDetails(parsed)).rejects.toThrow(/not found/i);
    });

    it('throws with auth message on 403', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
      await expect(fetchItemDetails(parsed)).rejects.toThrow(/access denied/i);
    });

    it('calls correct API endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'T', body: null, html_url: 'https://github.com/octocat/hello/issues/10' }),
      });

      await fetchItemDetails(parsed);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/octocat/hello/issues/10',
        expect.any(Object),
      );
    });

    it('retries with interactive auth on 404 and succeeds', async () => {
      vi.mocked(authentication.getSession)
        .mockResolvedValueOnce(undefined as any)
        .mockResolvedValueOnce({
          accessToken: 'interactive-token',
          id: 'test',
          account: { id: '1', label: 'user' },
          scopes: ['repo'],
        });
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ title: 'Private Issue', body: 'secret', html_url: 'https://github.com/octocat/hello/issues/10' }),
        });

      const result = await fetchItemDetails(parsed);
      expect(result.title).toBe('Private Issue');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('ADO Work Item', () => {
    const parsed: ParsedUrl = { type: 'ado-workitem', org: 'myorg', project: 'myproj', id: 99 };

    it('returns details on successful fetch', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ fields: { 'System.Title': 'User story', 'System.Description': 'As a user...', 'System.TeamProject': 'myproj' } }),
      });

      const result = await fetchItemDetails(parsed);
      expect(result).toEqual({
        title: 'User story',
        notes: 'As a user...',
        url: 'https://dev.azure.com/myorg/myproj/_workitems/edit/99',
        externalId: 'myorg/myproj/99',
        group: 'myorg/myproj',
        providerId: 'ado-work-items',
      });
    });

    it('uses canonical project name from API for externalId', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ fields: { 'System.Title': 'WI', 'System.Description': null, 'System.TeamProject': 'My Project' } }),
      });

      const result = await fetchItemDetails(parsed);
      expect(result.externalId).toBe('myorg/My Project/99');
      expect(result.group).toBe('myorg/My Project');
    });

    it('uses empty string for null description', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ fields: { 'System.Title': 'No desc', 'System.Description': null, 'System.TeamProject': 'myproj' } }),
      });

      const result = await fetchItemDetails(parsed);
      expect(result.notes).toBe('');
    });

    it('throws on 404', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
      await expect(fetchItemDetails(parsed)).rejects.toThrow(/not found/i);
    });

    it('throws with auth message on 401', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
      await expect(fetchItemDetails(parsed)).rejects.toThrow(/authentication required/i);
    });

    it('calls correct API endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ fields: { 'System.Title': 'T', 'System.Description': null, 'System.TeamProject': 'myproj' } }),
      });

      await fetchItemDetails(parsed);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://dev.azure.com/myorg/myproj/_apis/wit/workitems/99?api-version=7.1',
        expect.any(Object),
      );
    });

    it('retries with interactive auth on 404 and succeeds', async () => {
      vi.mocked(authentication.getSession)
        .mockResolvedValueOnce(undefined as any)
        .mockResolvedValueOnce({
          accessToken: 'ado-interactive-token',
          id: 'test',
          account: { id: '1', label: 'user' },
          scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        });
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ fields: { 'System.Title': 'Private WI', 'System.Description': 'secret', 'System.TeamProject': 'myproj' } }),
        });

      const result = await fetchItemDetails(parsed);
      expect(result.title).toBe('Private WI');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
