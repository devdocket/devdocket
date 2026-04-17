import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authentication } from 'vscode';
import { GitHubIssueProvider } from '../githubProvider';
import { GitHubPrReviewProvider } from '../githubPrReviewProvider';
import { initLogger, LogLevel } from '../logger';

// Mock global fetch
const mockFetch = vi.fn();

describe('resolveUrl', () => {
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockChannel = { appendLine: vi.fn() };
    initLogger(mockChannel as any, LogLevel.Debug);

    // Default: no auth session (silent returns undefined)
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('GitHubIssueProvider', () => {
    let provider: GitHubIssueProvider;

    beforeEach(() => {
      provider = new GitHubIssueProvider();
    });

    afterEach(() => {
      provider.dispose();
    });

    it('returns undefined for non-issue URLs', async () => {
      const result = await provider.resolveUrl('https://github.com/owner/repo');
      expect(result).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns undefined for PR URLs', async () => {
      const result = await provider.resolveUrl('https://github.com/owner/repo/pull/123');
      expect(result).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns correct ResolvedItem for valid issue URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Fix login bug',
          body: 'The login page is broken',
          html_url: 'https://github.com/owner/repo/issues/123',
        }),
      });

      const result = await provider.resolveUrl('https://github.com/owner/repo/issues/123');

      expect(result).toBeDefined();
      expect(result?.title).toBe('#123: Fix login bug');
      expect(result?.notes).toBe('The login page is broken');
      expect(result?.url).toBe('https://github.com/owner/repo/issues/123');
      expect(result?.externalId).toBe('owner/repo#123');
      expect(result?.group).toBe('owner/repo');
      expect(result?.providerId).toBe('github');

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo/issues/123',
        expect.objectContaining({
          headers: expect.any(Object),
        }),
      );
    });

    it('handles null body in issue response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Empty issue',
          body: null,
          html_url: 'https://github.com/owner/repo/issues/456',
        }),
      });

      const result = await provider.resolveUrl('https://github.com/owner/repo/issues/456');

      expect(result).toBeDefined();
      expect(result?.title).toBe('#456: Empty issue');
      expect(result?.notes).toBe('');
      expect(result?.externalId).toBe('owner/repo#456');
    });

    it('handles URL-encoded owner and repo names', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Test issue',
          body: 'Test',
          html_url: 'https://github.com/my-owner/my-repo/issues/789',
        }),
      });

      await provider.resolveUrl('https://github.com/my-owner/my-repo/issues/789');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/repos/my-owner/my-repo/issues/789'),
        expect.any(Object),
      );
    });

    it('retries with auth on 404 when initially unauthenticated', async () => {
      // First call (unauthenticated): 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      // Second call (with auth): 200
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Private issue',
          body: 'Now accessible',
          html_url: 'https://github.com/owner/repo/issues/999',
        }),
      });

      // Mock retryWithAuth to return successful response
      vi.mocked(authentication.getSession)
        .mockResolvedValueOnce(undefined) // silent: true returns undefined
        .mockResolvedValueOnce({ // createIfNone: true returns session
          accessToken: 'retry-token',
          id: 'session-1',
          scopes: ['repo'],
          account: { id: '1', label: 'testuser' },
        } as any);

      const result = await provider.resolveUrl('https://github.com/owner/repo/issues/999');

      expect(result).toBeDefined();
      expect(result?.title).toBe('#999: Private issue');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws on non-404 errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/issues/123'),
      ).rejects.toThrow();
    });

    it('throws on 404 when already authenticated', async () => {
      // Mock silent auth to return a session (authenticated)
      vi.mocked(authentication.getSession).mockResolvedValueOnce({
        accessToken: 'existing-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/issues/123'),
      ).rejects.toThrow('not found');

      // Should not retry since already authenticated
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(authentication.getSession)).toHaveBeenCalledTimes(1);
    });

    it('handles case-insensitive URLs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Mixed case',
          body: 'test',
          html_url: 'https://github.com/Owner/Repo/issues/111',
        }),
      });

      const result = await provider.resolveUrl('HTTPS://GITHUB.COM/Owner/Repo/ISSUES/111');

      expect(result).toBeDefined();
      expect(result?.title).toBe('#111: Mixed case');
    });

    it('respects AbortSignal cancellation', async () => {
      const controller = new AbortController();
      controller.abort();

      mockFetch.mockImplementationOnce(() => {
        throw new Error('Aborted');
      });

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/issues/123', controller.signal),
      ).rejects.toThrow();
    });
  });

  describe('GitHubPrReviewProvider', () => {
    let provider: GitHubPrReviewProvider;

    beforeEach(() => {
      provider = new GitHubPrReviewProvider();
    });

    afterEach(() => {
      provider.dispose();
    });

    it('returns undefined for non-PR URLs', async () => {
      const result = await provider.resolveUrl('https://github.com/owner/repo');
      expect(result).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns undefined for issue URLs', async () => {
      const result = await provider.resolveUrl('https://github.com/owner/repo/issues/123');
      expect(result).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns correct ResolvedItem for valid PR URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Add new feature',
          body: 'This PR adds a new feature',
          html_url: 'https://github.com/owner/repo/pull/456',
        }),
      });

      const result = await provider.resolveUrl('https://github.com/owner/repo/pull/456');

      expect(result).toBeDefined();
      expect(result?.title).toBe('#456: Add new feature');
      expect(result?.notes).toBe('This PR adds a new feature');
      expect(result?.url).toBe('https://github.com/owner/repo/pull/456');
      expect(result?.externalId).toBe('owner/repo#456');
      expect(result?.group).toBe('owner/repo');
      expect(result?.providerId).toBe('github-pr-reviews');

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo/pulls/456',
        expect.objectContaining({
          headers: expect.any(Object),
        }),
      );
    });

    it('handles null body in PR response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Empty PR',
          body: null,
          html_url: 'https://github.com/owner/repo/pull/789',
        }),
      });

      const result = await provider.resolveUrl('https://github.com/owner/repo/pull/789');

      expect(result).toBeDefined();
      expect(result?.title).toBe('#789: Empty PR');
      expect(result?.notes).toBe('');
      expect(result?.externalId).toBe('owner/repo#789');
    });

    it('retries with auth on 404 when initially unauthenticated', async () => {
      // First call (unauthenticated): 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      // Second call (with auth): 200
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Private PR',
          body: 'Now accessible',
          html_url: 'https://github.com/owner/repo/pull/555',
        }),
      });

      // Mock retryWithAuth to return successful response
      vi.mocked(authentication.getSession)
        .mockResolvedValueOnce(undefined) // silent: true returns undefined
        .mockResolvedValueOnce({ // createIfNone: true returns session
          accessToken: 'retry-token',
          id: 'session-1',
          scopes: ['repo'],
          account: { id: '1', label: 'testuser' },
        } as any);

      const result = await provider.resolveUrl('https://github.com/owner/repo/pull/555');

      expect(result).toBeDefined();
      expect(result?.title).toBe('#555: Private PR');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws on 404 when already authenticated', async () => {
      // Mock silent auth to return a session (authenticated)
      vi.mocked(authentication.getSession).mockResolvedValueOnce({
        accessToken: 'existing-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/pull/123'),
      ).rejects.toThrow('not found');

      // Should not retry since already authenticated
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(authentication.getSession)).toHaveBeenCalledTimes(1);
    });

    it('throws on 403 Forbidden', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/pull/123'),
      ).rejects.toThrow();
    });

    it('throws on 401 Unauthorized', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/pull/123'),
      ).rejects.toThrow();
    });

    it('handles case-insensitive URLs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Mixed case PR',
          body: 'test',
          html_url: 'https://github.com/Owner/Repo/pull/222',
        }),
      });

      const result = await provider.resolveUrl('HTTPS://GITHUB.COM/Owner/Repo/PULL/222');

      expect(result).toBeDefined();
      expect(result?.title).toBe('#222: Mixed case PR');
    });

    it('handles URL-encoded owner and repo names', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Test PR',
          body: 'Test',
          html_url: 'https://github.com/my-owner/my-repo/pull/333',
        }),
      });

      await provider.resolveUrl('https://github.com/my-owner/my-repo/pull/333');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/repos/my-owner/my-repo/pulls/333'),
        expect.any(Object),
      );
    });

    it('respects AbortSignal cancellation', async () => {
      const controller = new AbortController();
      controller.abort();

      mockFetch.mockImplementationOnce(() => {
        throw new Error('Aborted');
      });

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/pull/123', controller.signal),
      ).rejects.toThrow();
    });
  });
});
