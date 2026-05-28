import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authentication, env } from 'vscode';
import { isRecoverableError, PollingBackoffError } from '@devdocket/shared';
import { GitHubSsoError, fetchClosedGitHubItems, filterMergedGitHubPrs, isMergedGitHubPr, throwApiError, looksLikeRateLimited403, retryWithAuth, type GitHubIssue } from '../githubApiHelpers';
import { setLogger } from '../logger';
import { makeErrorResponse } from './responseMocks';

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
  vi.restoreAllMocks();
});

describe('GitHubSsoError', () => {
  it('is recognized as a recoverable error', () => {
    const error = new GitHubSsoError({
      orgName: 'example',
      ssoUrl: 'https://github.com/orgs/example/sso?authorization_request=abc123',
    });

    expect(isRecoverableError(error)).toBe(true);
    expect(error.recoverable).toBe(true);
  });

  it('includes an authorize action when a direct SSO URL is present', async () => {
    const error = new GitHubSsoError({
      orgName: 'example',
      ssoUrl: 'https://github.com/orgs/example/sso?authorization_request=abc123',
    });

    expect(error.actions).toHaveLength(1);
    expect(error.actions?.[0]).toMatchObject({
      label: 'Authorize in browser',
      retryAfterAction: true,
    });

    await error.actions?.[0]?.run();

    expect(env.openExternal).toHaveBeenCalledWith(expect.objectContaining({ toString: expect.any(Function) }));
    expect(env.openExternal.mock.calls[0][0].toString()).toBe('https://github.com/orgs/example/sso?authorization_request=abc123');
  });

  it('falls back to the organization SSO URL when no direct URL is present', async () => {
    const error = new GitHubSsoError({ orgName: 'example-fallback' });

    expect(error.actions).toHaveLength(1);

    await error.actions?.[0]?.run();

    expect(env.openExternal.mock.calls[0][0].toString()).toBe('https://github.com/orgs/example-fallback/sso');
  });

  it('omits the authorize action when no safe URL is available', () => {
    expect(new GitHubSsoError().actions).toBeUndefined();
    expect(new GitHubSsoError({ ssoUrl: 'file:///not-safe' }).actions).toBeUndefined();
  });

  it('stores only trusted GitHub SSO URLs on the error surface', () => {
    expect(new GitHubSsoError({
      ssoUrl: 'https://github.com/orgs/example/sso?authorization_request=abc123',
    }).ssoUrl).toBe('https://github.com/orgs/example/sso?authorization_request=abc123');
    expect(new GitHubSsoError({ ssoUrl: 'https://evil.example.com/orgs/example/sso' }).ssoUrl).toBeUndefined();
    expect(new GitHubSsoError({ ssoUrl: 'file:///not-safe' }).ssoUrl).toBeUndefined();
  });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

describe('fetchClosedGitHubItems', () => {
  beforeEach(() => {
    vi.mocked(authentication.getSession).mockResolvedValue({ accessToken: 'closed-token' } as never);
  });

  it('fetches a single closed issue through GraphQL', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: { repository: { i0: { state: 'CLOSED' }, pr0: null } },
      }),
    }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(fetchClosedGitHubItems(['owner/repo#1'], 'issues')).resolves.toEqual(['owner/repo#1']);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/graphql');
    const body = JSON.parse(String(init?.body));
    expect(init?.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer closed-token',
      'User-Agent': 'DevDocket-VSCode',
      'Content-Type': 'application/json',
    }));
    expect(body.variables).toEqual({ owner: 'owner', name: 'repo' });
    expect(body.query).toContain('i0: issue(number: 1)');
    expect(body.query).toContain('pr0: pullRequest(number: 1)');
  });

  it('batches multiple repositories and treats merged PRs as closed', async () => {
    const mockFetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body));
      if (body.variables.owner === 'owner' && body.variables.name === 'repo') {
        return {
          ok: true,
          json: async () => ({
            data: { repository: { pr0: { state: 'CLOSED' }, pr1: { state: 'OPEN' } } },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: { repository: { pr0: { state: 'MERGED' } } },
        }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchClosedGitHubItems([
      'owner/repo#1',
      'owner/repo#2',
      'other/project#3',
    ], 'pulls');

    expect(result).toEqual(['owner/repo#1', 'other/project#3']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mockFetch.mock.calls) {
      const body = JSON.parse(String(init?.body));
      expect(body.query).not.toContain('issue(number:');
    }
  });

  it('keeps successful repo results when another repo query and fallback fail', async () => {
    const mockFetch = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body));
        if (body.variables.owner === 'owner') {
          return {
            ok: true,
            json: async () => ({ data: { repository: { i0: { state: 'CLOSED' }, pr0: null } } }),
          };
        }
        return makeErrorResponse({ status: 500, statusText: 'Internal Server Error', bodyJson: { message: 'temporary failure' } });
      }
      return makeErrorResponse({ status: 404, statusText: 'Not Found' });
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(fetchClosedGitHubItems(['owner/repo#1', 'broken/repo#2'], 'issues'))
      .resolves.toEqual(['owner/repo#1']);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('ignores missing GraphQL items', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: { repository: { i0: null, pr0: null } },
      }),
    }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(fetchClosedGitHubItems(['owner/repo#99'], 'issues')).resolves.toEqual([]);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws PollingBackoffError for GraphQL secondary rate limits', async () => {
    const mockFetch = vi.fn(async () => makeErrorResponse({
      status: 403,
      statusText: 'Forbidden',
      headers: { 'retry-after': '30' },
      bodyJson: { message: 'You have exceeded a secondary rate limit.' },
    }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(fetchClosedGitHubItems(['owner/repo#1'], 'pulls'))
      .rejects.toBeInstanceOf(PollingBackoffError);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws PollingBackoffError for 200 OK GraphQL rate-limit errors', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'x-ratelimit-reset' ? String(Math.floor(Date.now() / 1000) + 60) : null },
      json: async () => ({
        errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for GraphQL.' }],
      }),
    }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(fetchClosedGitHubItems(['owner/repo#1'], 'issues'))
      .rejects.toMatchObject({ name: 'PollingBackoffError', statusCode: 200 });
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws PollingBackoffError when REST fallback hits a secondary rate limit', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === 'https://api.github.com/graphql') {
        return makeErrorResponse({ status: 500, statusText: 'Internal Server Error', bodyJson: { message: 'temporary failure' } });
      }
      return makeErrorResponse({
        status: 403,
        statusText: 'Forbidden',
        headers: { 'retry-after': '30' },
        bodyJson: { message: 'You have exceeded a secondary rate limit.' },
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(fetchClosedGitHubItems(['owner/repo#1'], 'issues'))
      .rejects.toBeInstanceOf(PollingBackoffError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('skips REST fallback items that require SSO without warning', async () => {
    const mockChannel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() };
    setLogger(mockChannel as any);
    const mockFetch = vi.fn(async (url: string) => {
      if (url === 'https://api.github.com/graphql') {
        throw new Error('temporary failure');
      }
      return makeErrorResponse({
        status: 403,
        statusText: 'Forbidden',
        headers: { 'x-github-sso': 'required; url=https://github.com/orgs/example/sso' },
        bodyJson: { message: 'Resource protected by organization SAML enforcement.' },
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(fetchClosedGitHubItems(['owner/repo#1'], 'issues')).resolves.toEqual([]);
    expect(mockChannel.warn).not.toHaveBeenCalled();
    expect(mockChannel.debug).toHaveBeenCalledWith(expect.stringContaining('REST closed-item check after SSO error'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('retryWithAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws abort without requesting a session when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(retryWithAuth('https://api.github.com/test', controller.signal, { interactive: true }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(authentication.getSession).not.toHaveBeenCalled();
  });

  it('rejects when cancellation fires while waiting for getSession', async () => {
    const controller = new AbortController();
    const pending = deferred<any>();
    vi.mocked(authentication.getSession).mockReturnValueOnce(pending.promise);

    const promise = retryWithAuth('https://api.github.com/test', controller.signal, { interactive: true });
    controller.abort();
    pending.resolve(undefined);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('checks for a silent session before skipping background retries', async () => {
    vi.mocked(authentication.getSession).mockResolvedValueOnce(undefined as never);

    await expect(retryWithAuth('https://api.github.com/test', undefined, { interactive: false }))
      .resolves.toBeUndefined();
    expect(authentication.getSession).toHaveBeenCalledTimes(1);
    expect(authentication.getSession).toHaveBeenCalledWith('github', ['repo'], { silent: true });
  });

  it('falls back to createIfNone only for interactive callers', async () => {
    vi.mocked(authentication.getSession)
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce({ accessToken: 'interactive-token' } as never);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await retryWithAuth('https://api.github.com/test', undefined, { interactive: true });

    expect(authentication.getSession).toHaveBeenNthCalledWith(1, 'github', ['repo'], { silent: true });
    expect(authentication.getSession).toHaveBeenNthCalledWith(2, 'github', ['repo'], { createIfNone: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('throwApiError', () => {
  let mockChannel: { info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockChannel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() };
    setLogger(mockChannel as any);
  });

  it('throws a "not found" message for 404 responses', async () => {
    const response = makeErrorResponse({ status: 404, statusText: 'Not Found' });
    await expect(throwApiError(response, 'GitHub issue org/repo#1'))
      .rejects.toThrow('GitHub issue org/repo#1 not found. It may be private or deleted.');
  });

  it('throws an authentication-failure message for 401 (does NOT mention "private")', async () => {
    const response = makeErrorResponse({
      status: 401,
      statusText: 'Unauthorized',
      bodyJson: { message: 'Bad credentials' },
    });
    await expect(throwApiError(response, 'GitHub issue org/repo#1'))
      .rejects.toThrow(/authentication failed.*Bad credentials.*Sign in to GitHub/i);
    await expect(throwApiError(makeErrorResponse({
      status: 401, bodyJson: { message: 'Bad credentials' },
    }), 'GitHub issue org/repo#1'))
      .rejects.not.toThrow(/private/i);
  });

  it('throws a rate-limit message for 403 with x-ratelimit-remaining=0', async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 600; // 10 minutes from now
    const response = makeErrorResponse({
      status: 403,
      statusText: 'Forbidden',
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetEpoch),
      },
      bodyJson: { message: 'API rate limit exceeded for 1.2.3.4.' },
    });
    await expect(throwApiError(response, 'GitHub issue org/repo#1'))
      .rejects.toThrow(/GitHub API rate limit exceeded for GitHub issue org\/repo#1\. Resets in 10 minutes\./);
  });

  it('throws a rate-limit message for 403 when body mentions "API rate limit exceeded" even without remaining=0', async () => {
    const response = makeErrorResponse({
      status: 403,
      bodyJson: { message: 'API rate limit exceeded for installation ID 42.' },
    });
    await expect(throwApiError(response, 'GitHub PR org/repo#5'))
      .rejects.toThrow(/rate limit exceeded/i);
  });

  it('throws a secondary-rate-limit message when body mentions secondary rate limit', async () => {
    const response = makeErrorResponse({
      status: 403,
      headers: { 'retry-after': '30' },
      bodyJson: { message: 'You have exceeded a secondary rate limit.' },
    });
    await expect(throwApiError(response, 'GitHub issue org/repo#1'))
      .rejects.toThrow(/secondary rate limit.*Retry after 30s/i);
  });

  it('throws a PollingBackoffError for HTTP 429 responses', async () => {
    const response = makeErrorResponse({
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'retry-after': '60' },
      bodyJson: { message: 'Too many requests' },
    });

    await expect(throwApiError(response, 'GitHub issue org/repo#1')).rejects.toMatchObject({
      name: 'PollingBackoffError',
      backoffKey: 'api.github.com',
      retryAfterMs: 60_000,
    });
    await expect(throwApiError(response, 'GitHub issue org/repo#1')).rejects.toBeInstanceOf(PollingBackoffError);
  });

  it('throws a secondary-rate-limit message with an HTTP-date Retry-After', async () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const response = makeErrorResponse({
      status: 403,
      headers: { 'retry-after': future },
      bodyJson: { message: 'Secondary rate limit exceeded' },
    });
    await expect(throwApiError(response, 'GitHub issue org/repo#1'))
      .rejects.toThrow(/secondary rate limit.*Retry after \d+s/i);
  });

  it('throws a GitHubSsoError with org name and SSO URL from the response header', async () => {
    const response = makeErrorResponse({
      status: 403,
      headers: { 'x-github-sso': 'required; url=https://github.com/orgs/example/sso?authorization_request=abc123' },
      bodyJson: { message: 'Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.' },
    });

    await expect(throwApiError(response, 'GitHub issue org/repo#1')).rejects.toMatchObject({
      name: 'GitHubSsoError',
      message: 'DevDocket: GitHub requires SSO authorization for the "example" organization\nbefore this item can be loaded.',
      ssoUrl: 'https://github.com/orgs/example/sso?authorization_request=abc123',
      orgName: 'example',
      recoverable: true,
      actions: [expect.objectContaining({
        label: 'Authorize in browser',
        retryAfterAction: true,
      })],
    });

    await expect(throwApiError(makeErrorResponse({
      status: 403,
      headers: { 'x-github-sso': 'required; url=https://github.com/orgs/example/sso?authorization_request=abc123' },
      bodyJson: { message: 'Resource protected by organization SAML enforcement.' },
    }), 'GitHub issue org/repo#1')).rejects.toBeInstanceOf(GitHubSsoError);
  });

  it('prefers SSO classification over a coincidental remaining=0', async () => {
    const response = makeErrorResponse({
      status: 403,
      headers: {
        'x-github-sso': 'required; url=https://github.com/orgs/example/sso',
        'x-ratelimit-remaining': '0',
      },
      bodyJson: { message: 'Resource protected by organization SAML enforcement.' },
    });
    await expect(throwApiError(response, 'GitHub issue org/repo#1'))
      .rejects.toMatchObject({
        name: 'GitHubSsoError',
        orgName: 'example',
        message: 'DevDocket: GitHub requires SSO authorization for the "example" organization\nbefore this item can be loaded.',
      });
  });

  it('prefers secondary-rate-limit classification over a coincidental remaining=0', async () => {
    const response = makeErrorResponse({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'retry-after': '30' },
      bodyJson: { message: 'You have exceeded a secondary rate limit.' },
    });
    await expect(throwApiError(response, 'GitHub issue org/repo#1'))
      .rejects.toThrow(/secondary rate limit/i);
  });

  it('throws a generic 403 message (NOT "private repo") when no rate-limit / SSO signal is present', async () => {
    const response = makeErrorResponse({
      status: 403,
      statusText: 'Forbidden',
      bodyJson: { message: 'Must have admin rights to Repository.' },
    });
    await expect(throwApiError(response, 'GitHub issue org/repo#1'))
      .rejects.toThrow(/GitHub denied access to GitHub issue org\/repo#1 \(HTTP 403\): Must have admin rights to Repository\./);
  });

  it('throws a status-based error for other HTTP failures (e.g., 500)', async () => {
    const response = makeErrorResponse({
      status: 500,
      statusText: 'Internal Server Error',
      bodyJson: { message: 'Something went wrong' },
    });
    await expect(throwApiError(response, 'GitHub issue org/repo#1'))
      .rejects.toThrow(/HTTP 500 Internal Server Error.*Something went wrong/);
  });

  it('logs a warn line with the status, headers, message AND raw body snippet before throwing', async () => {
    const response = makeErrorResponse({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
      bodyJson: { message: 'API rate limit exceeded', documentation_url: 'https://docs.github.com/rest/overview/rate-limits' },
    });
    await expect(throwApiError(response, 'GitHub issue org/repo#1')).rejects.toThrow();
    expect(mockChannel.warn).toHaveBeenCalledOnce();
    const logged = String(mockChannel.warn.mock.calls[0][0]);
    expect(logged).toContain('GitHub API request failed for GitHub issue org/repo#1');
    expect(logged).toContain('status=403');
    expect(logged).toContain('rate-limit-remaining=0');
    expect(logged).toContain('rate-limit-reset=1700000000');
    expect(logged).toContain('message="API rate limit exceeded"');
    // Body snippet must also be present so the logger captures fields beyond `message`.
    expect(logged).toContain('body=');
    expect(logged).toContain('documentation_url');
  });

  it('tolerates a missing/empty response body without crashing', async () => {
    const response = makeErrorResponse({ status: 403, statusText: 'Forbidden' });
    await expect(throwApiError(response, 'GitHub issue org/repo#1'))
      .rejects.toThrow(/GitHub denied access to GitHub issue org\/repo#1 \(HTTP 403\).*token may lack required permissions/);
  });

  it('tolerates a non-JSON response body without crashing', async () => {
    const response = makeErrorResponse({ status: 502, bodyText: '<html>bad gateway</html>' });
    await expect(throwApiError(response, 'GitHub issue org/repo#1'))
      .rejects.toThrow(/HTTP 502/);
  });
});

describe('looksLikeRateLimited403', () => {
  it('returns true when status is 403 and x-ratelimit-remaining is 0', () => {
    const response = makeErrorResponse({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' },
    });
    expect(looksLikeRateLimited403(response)).toBe(true);
  });

  it('returns true when status is 403 and Retry-After is a finite number', () => {
    const response = makeErrorResponse({
      status: 403,
      headers: { 'retry-after': '30' },
    });
    expect(looksLikeRateLimited403(response)).toBe(true);
  });

  it('returns false for 403 without rate-limit signals', () => {
    const response = makeErrorResponse({
      status: 403,
      bodyJson: { message: 'Must have admin rights to Repository.' },
    });
    expect(looksLikeRateLimited403(response)).toBe(false);
  });

  it('returns false for 403 with a non-zero remaining quota', () => {
    const response = makeErrorResponse({
      status: 403,
      headers: { 'x-ratelimit-remaining': '4999' },
    });
    expect(looksLikeRateLimited403(response)).toBe(false);
  });

  it('returns false for non-403 statuses even with rate-limit headers', () => {
    const response = makeErrorResponse({
      status: 404,
      headers: { 'x-ratelimit-remaining': '0' },
    });
    expect(looksLikeRateLimited403(response)).toBe(false);
  });

  it('returns true for HTTP-date Retry-After (RFC 7231 alternate form)', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const response = makeErrorResponse({
      status: 403,
      headers: { 'retry-after': future },
    });
    expect(looksLikeRateLimited403(response)).toBe(true);
  });

  it('returns false for completely unparseable Retry-After', () => {
    const response = makeErrorResponse({
      status: 403,
      headers: { 'retry-after': 'not a date or number' },
    });
    expect(looksLikeRateLimited403(response)).toBe(false);
  });
});
