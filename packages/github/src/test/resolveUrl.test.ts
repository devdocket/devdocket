import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authentication } from 'vscode';
import { GitHubIssueProvider } from '../githubProvider';
import { GitHubPrReviewProvider } from '../githubPrReviewProvider';
import { setLogger } from '../logger';
import { makeErrorResponse } from './responseMocks';

// Mock global fetch
const mockFetch = vi.fn();

describe('resolveUrl', () => {
  let mockChannel: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockChannel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() };
    setLogger(mockChannel);

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

    it('returns correct ProviderItem for valid issue URL', async () => {
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
      expect(result?.description).toBe('The login page is broken');
      expect(result?.url).toBe('https://github.com/owner/repo/issues/123');
      expect(result?.externalId).toBe('owner/repo#123');
      expect(result?.group).toBe('owner/repo');
      expect(result?.canonicalId).toBe('github:issue:owner/repo#123');
      expect(result?.itemType).toBe('issue');
      expect(result?.capabilities?.gitWork).toEqual({
        kind: 'issue',
        cloneUrl: 'https://github.com/owner/repo.git',
        ref: 'issue123',
        repoLabel: 'owner/repo',
      });

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
      expect(result?.description).toBeUndefined();
      expect(result?.externalId).toBe('owner/repo#456');
    });

    it('handles hyphenated owner and repo names', async () => {
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
      mockFetch.mockResolvedValueOnce(makeErrorResponse({ status: 404 }));

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

    it('retries with auth on 403 when initially unauthenticated', async () => {
      // First call (unauthenticated): 403 (likely IP-based rate limit)
      mockFetch.mockResolvedValueOnce(makeErrorResponse({
        status: 403,
        statusText: 'Forbidden',
        headers: { 'x-ratelimit-remaining': '0' },
        bodyJson: { message: 'API rate limit exceeded for 1.2.3.4.' },
      }));

      // Second call (with auth): 200
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Public issue',
          body: 'Now accessible',
          html_url: 'https://github.com/owner/repo/issues/888',
        }),
      });

      vi.mocked(authentication.getSession)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          accessToken: 'retry-token',
          id: 'session-1',
          scopes: ['repo'],
          account: { id: '1', label: 'testuser' },
        } as any);

      const result = await provider.resolveUrl('https://github.com/owner/repo/issues/888');

      expect(result).toBeDefined();
      expect(result?.title).toBe('#888: Public issue');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry with auth on a generic 403 (no rate-limit signal)', async () => {
      // Unauthenticated 403 without rate-limit headers — e.g., a permission
      // policy denial. Prompting the user to sign in would be unhelpful here.
      mockFetch.mockResolvedValueOnce(makeErrorResponse({
        status: 403,
        statusText: 'Forbidden',
        bodyJson: { message: 'Must have admin rights to Repository.' },
      }));

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/issues/123'),
      ).rejects.toThrow(/GitHub denied access.*Must have admin rights/);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      // Only the initial silent session lookup should be made — no createIfNone prompt.
      expect(vi.mocked(authentication.getSession)).toHaveBeenCalledTimes(1);
    });

    it('surfaces the retried response error when auth retry also fails', async () => {
      // First (unauthenticated) request: 403 rate-limit-shaped → triggers retry.
      mockFetch.mockResolvedValueOnce(makeErrorResponse({
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
        bodyJson: { message: 'API rate limit exceeded for 1.2.3.4.' },
      }));
      // Second (authenticated) request: 404 → distinct error from the retried
      // response, not from the original 403.
      mockFetch.mockResolvedValueOnce(makeErrorResponse({
        status: 404,
        bodyJson: { message: 'Not Found' },
      }));

      vi.mocked(authentication.getSession)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          accessToken: 'retry-token',
          id: 'session-1',
          scopes: ['repo'],
          account: { id: '1', label: 'testuser' },
        } as any);

      let caught: unknown;
      try {
        await provider.resolveUrl('https://github.com/owner/repo/issues/123');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toMatch(/not found/i);
      // Make sure we don't surface the original 403 rate-limit message.
      expect(message).not.toMatch(/rate limit/i);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws rate-limit error on 403 when already authenticated and limit is hit', async () => {
      vi.mocked(authentication.getSession).mockResolvedValueOnce({
        accessToken: 'existing-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      const resetEpoch = Math.floor(Date.now() / 1000) + 1800; // 30 minutes from now
      mockFetch.mockResolvedValueOnce(makeErrorResponse({
        status: 403,
        statusText: 'Forbidden',
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(resetEpoch),
        },
        bodyJson: { message: 'API rate limit exceeded for user ID 1.' },
      }));

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/issues/123'),
      ).rejects.toThrow(/rate limit exceeded/i);
    });

    it('throws SSO error on 403 with x-github-sso header', async () => {
      vi.mocked(authentication.getSession).mockResolvedValueOnce({
        accessToken: 'existing-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      mockFetch.mockResolvedValueOnce(makeErrorResponse({
        status: 403,
        statusText: 'Forbidden',
        headers: { 'x-github-sso': 'required; url=https://github.com/orgs/example/sso' },
        bodyJson: { message: 'Resource protected by organization SAML enforcement.' },
      }));

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/issues/123'),
      ).rejects.toThrow('DevDocket: GitHub requires SSO authorization for the "example" organization\nbefore this item can be loaded.');
    });

    it('throws generic 403 error (not rate limit / SSO) with API message', async () => {
      vi.mocked(authentication.getSession).mockResolvedValueOnce({
        accessToken: 'existing-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      mockFetch.mockResolvedValueOnce(makeErrorResponse({
        status: 403,
        statusText: 'Forbidden',
        bodyJson: { message: 'Must have admin rights to Repository.' },
      }));

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/issues/123'),
      ).rejects.toThrow(/Must have admin rights to Repository/);
    });

    it('throws auth error on 401 (does not blame "private repo")', async () => {
      vi.mocked(authentication.getSession).mockResolvedValueOnce({
        accessToken: 'existing-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      mockFetch.mockResolvedValueOnce(makeErrorResponse({
        status: 401,
        statusText: 'Unauthorized',
        bodyJson: { message: 'Bad credentials' },
      }));

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/issues/123'),
      ).rejects.toThrow(/authentication failed/i);
    });

    it('throws on 404 when already authenticated', async () => {
      // Mock silent auth to return a session (authenticated)
      vi.mocked(authentication.getSession).mockResolvedValueOnce({
        accessToken: 'existing-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      mockFetch.mockResolvedValueOnce(makeErrorResponse({ status: 404 }));

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

    it('skips interactive auth retry when issue resolveUrl is non-interactive', async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse({ status: 404 }));

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/issues/123', undefined, { interactive: false }),
      ).rejects.toThrow('not found');

      expect(vi.mocked(authentication.getSession)).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
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

    it('returns correct ProviderItem for valid PR URL', async () => {
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
      expect(result?.description).toBe('This PR adds a new feature');
      expect(result?.url).toBe('https://github.com/owner/repo/pull/456');
      expect(result?.externalId).toBe('owner/repo#456');
      expect(result?.group).toBe('owner/repo');
      expect(result?.canonicalId).toBe('github:pull:owner/repo#456');
      expect(result?.itemType).toBe('pr');
      expect(result?.capabilities?.gitWork).toEqual(expect.any(Function));

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
      expect(result?.description).toBeUndefined();
      expect(result?.externalId).toBe('owner/repo#789');
    });

    it('retries with auth on 404 when initially unauthenticated', async () => {
      // First call (unauthenticated): 404
      mockFetch.mockResolvedValueOnce(makeErrorResponse({ status: 404 }));

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

    it('retries with auth on 403 when initially unauthenticated', async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse({
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
        bodyJson: { message: 'API rate limit exceeded for 1.2.3.4.' },
      }));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Public PR',
          body: 'Now accessible',
          html_url: 'https://github.com/owner/repo/pull/777',
        }),
      });

      vi.mocked(authentication.getSession)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          accessToken: 'retry-token',
          id: 'session-1',
          scopes: ['repo'],
          account: { id: '1', label: 'testuser' },
        } as any);

      const result = await provider.resolveUrl('https://github.com/owner/repo/pull/777');

      expect(result).toBeDefined();
      expect(result?.title).toBe('#777: Public PR');
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

      mockFetch.mockResolvedValueOnce(makeErrorResponse({ status: 404 }));

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/pull/123'),
      ).rejects.toThrow('not found');

      // Should not retry since already authenticated
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(authentication.getSession)).toHaveBeenCalledTimes(1);
    });

    it('throws rate-limit error on 403 Forbidden with rate-limit signature', async () => {
      vi.mocked(authentication.getSession).mockResolvedValueOnce({
        accessToken: 'existing-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      mockFetch.mockResolvedValueOnce(makeErrorResponse({
        status: 403,
        statusText: 'Forbidden',
        headers: { 'x-ratelimit-remaining': '0' },
        bodyJson: { message: 'API rate limit exceeded' },
      }));

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/pull/123'),
      ).rejects.toThrow(/rate limit exceeded/i);
    });

    it('throws auth error on 401 Unauthorized', async () => {
      vi.mocked(authentication.getSession).mockResolvedValueOnce({
        accessToken: 'existing-token',
        id: 'session-1',
        scopes: ['repo'],
        account: { id: '1', label: 'testuser' },
      } as any);

      mockFetch.mockResolvedValueOnce(makeErrorResponse({
        status: 401,
        statusText: 'Unauthorized',
        bodyJson: { message: 'Bad credentials' },
      }));

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/pull/123'),
      ).rejects.toThrow(/authentication failed/i);
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

    it('handles hyphenated owner and repo names', async () => {
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

    it('skips interactive auth retry when PR resolveUrl is non-interactive', async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse({ status: 404 }));

      await expect(
        provider.resolveUrl('https://github.com/owner/repo/pull/123', undefined, { interactive: false }),
      ).rejects.toThrow('not found');

      expect(vi.mocked(authentication.getSession)).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
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
