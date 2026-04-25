import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveRepos } from '../repoResolver';
import { parseRepoPatterns } from '../repoPattern';

describe('resolveRepos', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonResponse(data: unknown, headers?: Record<string, string>): Response {
    const headerMap = new Headers(headers);
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
      headers: headerMap,
    } as unknown as Response;
  }

  function notFoundResponse(): Response {
    return {
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
      headers: new Headers(),
    } as unknown as Response;
  }

  it('returns exact repos without making API calls', async () => {
    const patterns = parseRepoPatterns('owner/repo1\nowner/repo2');
    const result = await resolveRepos(patterns, 'token');
    expect(result).toEqual(['owner/repo1', 'owner/repo2']);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves wildcard patterns via org API', async () => {
    const patterns = parseRepoPatterns('myorg/*');
    mockFetch.mockResolvedValueOnce(jsonResponse([
      { full_name: 'myorg/repo1' },
      { full_name: 'myorg/repo2' },
    ]));

    const result = await resolveRepos(patterns, 'token');
    expect(result).toEqual(expect.arrayContaining(['myorg/repo1', 'myorg/repo2']));
    expect(result).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toContain('/orgs/myorg/repos');
  });

  it('falls back to user endpoint on org 404', async () => {
    const patterns = parseRepoPatterns('someuser/*');
    mockFetch
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(jsonResponse([
        { full_name: 'someuser/repo1' },
      ]));

    const result = await resolveRepos(patterns, 'token');
    expect(result).toEqual(['someuser/repo1']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toContain('/users/someuser/repos');
  });

  it('paginates using Link header', async () => {
    const patterns = parseRepoPatterns('myorg/*');
    mockFetch
      .mockResolvedValueOnce(jsonResponse(
        [{ full_name: 'myorg/repo1' }],
        { link: '<https://api.github.com/orgs/myorg/repos?page=2>; rel="next"' },
      ))
      .mockResolvedValueOnce(jsonResponse(
        [{ full_name: 'myorg/repo2' }],
      ));

    const result = await resolveRepos(patterns, 'token');
    expect(result).toEqual(expect.arrayContaining(['myorg/repo1', 'myorg/repo2']));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('applies exclusion patterns to filter results', async () => {
    const patterns = parseRepoPatterns('myorg/*\n!myorg/secret');
    mockFetch.mockResolvedValueOnce(jsonResponse([
      { full_name: 'myorg/public' },
      { full_name: 'myorg/secret' },
    ]));

    const result = await resolveRepos(patterns, 'token');
    expect(result).toEqual(['myorg/public']);
  });

  it('combines exact and wildcard repos', async () => {
    const patterns = parseRepoPatterns('exact-owner/specific-repo\nwild-org/*');
    mockFetch.mockResolvedValueOnce(jsonResponse([
      { full_name: 'wild-org/repo1' },
      { full_name: 'wild-org/repo2' },
    ]));

    const result = await resolveRepos(patterns, 'token');
    expect(result).toEqual(expect.arrayContaining([
      'exact-owner/specific-repo',
      'wild-org/repo1',
      'wild-org/repo2',
    ]));
    expect(result).toHaveLength(3);
    // Only the wildcard org should trigger API calls
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toContain('/orgs/wild-org/repos');
  });

  it('handles network error with partial results', async () => {
    const patterns = parseRepoPatterns('myorg/*');
    mockFetch
      .mockResolvedValueOnce(jsonResponse(
        [{ full_name: 'myorg/repo1' }],
        { link: '<https://api.github.com/orgs/myorg/repos?page=2>; rel="next"' },
      ))
      .mockRejectedValueOnce(new Error('Network error'));

    const result = await resolveRepos(patterns, 'token');
    expect(result).toEqual(['myorg/repo1']);
  });

  it('throws on abort signal', async () => {
    const patterns = parseRepoPatterns('myorg/*');
    const controller = new AbortController();
    controller.abort();

    await expect(resolveRepos(patterns, 'token', controller.signal))
      .rejects.toThrow('The operation was aborted.');
  });

  it('returns empty array when both org and user endpoints return 404', async () => {
    const patterns = parseRepoPatterns('ghost/*');
    mockFetch
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(notFoundResponse());

    const result = await resolveRepos(patterns, 'token');
    expect(result).toEqual([]);
  });

  it('deduplicates repos from exact and wildcard sources', async () => {
    const patterns = parseRepoPatterns('myorg/repo1\nmyorg/*');
    mockFetch.mockResolvedValueOnce(jsonResponse([
      { full_name: 'myorg/repo1' },
      { full_name: 'myorg/repo2' },
    ]));

    const result = await resolveRepos(patterns, 'token');
    expect(result).toEqual(expect.arrayContaining(['myorg/repo1', 'myorg/repo2']));
    expect(result).toHaveLength(2);
  });

  it('sends User-Agent and auth headers', async () => {
    const patterns = parseRepoPatterns('myorg/*');
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    await resolveRepos(patterns, 'my-token');
    const headers = mockFetch.mock.calls[0][1]?.headers;
    expect(headers).toMatchObject({
      Authorization: 'Bearer my-token',
      'User-Agent': 'DevDocket-VSCode',
    });
  });

  it('resolves multiple wildcard owners in parallel', async () => {
    const patterns = parseRepoPatterns('org1/*\norg2/*');
    mockFetch
      .mockResolvedValueOnce(jsonResponse([{ full_name: 'org1/repo' }]))
      .mockResolvedValueOnce(jsonResponse([{ full_name: 'org2/repo' }]));

    const result = await resolveRepos(patterns, 'token');
    expect(result).toEqual(expect.arrayContaining(['org1/repo', 'org2/repo']));
    expect(result).toHaveLength(2);
  });
});
