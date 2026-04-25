import { combineSignals } from '@devdocket/shared';
import { logger } from './logger';
import { type RepoPattern, extractOwners, matchesRepoPatterns, getExactRepos, hasWildcardPatterns } from './repoPattern';

interface GitHubRepoResponse {
  full_name: string;
}

/**
 * Resolve repo patterns into a concrete list of "owner/repo" strings.
 * Exact patterns are returned as-is. Wildcard patterns trigger GitHub API
 * listing for the owner (tries org endpoint first, falls back to user).
 */
export async function resolveRepos(
  patterns: RepoPattern[],
  token: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const exact = getExactRepos(patterns);
  const allRepos = new Set<string>(exact);

  if (hasWildcardPatterns(patterns)) {
    const owners = extractOwners(patterns);
    const ownerResults = await Promise.all(
      owners.map(owner => {
        if (signal?.aborted) {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        return listOwnerRepos(owner, token, signal);
      })
    );
    for (const repos of ownerResults) {
      for (const repo of repos) {
        allRepos.add(repo);
      }
    }
  }

  // Apply full pattern set (including exclusions) to filter
  return [...allRepos].filter(repo => matchesRepoPatterns(repo, patterns));
}

/**
 * List all repos for an owner via GitHub API.
 * Tries /orgs/{owner}/repos first; on 404, falls back to /users/{owner}/repos.
 * Paginates up to 10 pages (1000 repos).
 */
async function listOwnerRepos(
  owner: string,
  token: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const orgUrl = `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos?per_page=100`;
  let repos = await fetchPaginatedRepos(orgUrl, token, signal);

  if (repos === null) {
    // Org endpoint returned 404; try user endpoint
    const userUrl = `https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100`;
    repos = await fetchPaginatedRepos(userUrl, token, signal);
  }

  return repos ?? [];
}

async function fetchPaginatedRepos(
  startUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const allRepos: string[] = [];
  let nextUrl: string | null = startUrl;
  let page = 0;
  const maxPages = 10;

  while (nextUrl && page < maxPages) {
    if (signal?.aborted) {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }

    let response: Response;
    try {
      response = await fetch(nextUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'DevDocket-VSCode',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: combineSignals(signal, 30_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') { throw err; }
      logger.warn(`Failed to list repos from ${nextUrl}`, err);
      // Return [] not null — null is reserved for 404 org-not-found fallback
      return allRepos.length > 0 ? allRepos : [];
    }

    if (response.status === 404 && page === 0) {
      return null;
    }

    if (!response.ok) {
      logger.warn(`GitHub API returned ${response.status} listing repos from ${nextUrl}`);
      return allRepos.length > 0 ? allRepos : [];
    }

    const data = (await response.json()) as GitHubRepoResponse[];
    for (const repo of data) {
      allRepos.push(repo.full_name);
    }

    nextUrl = getNextPageUrl(response.headers.get('link'));
    page++;
  }

  return allRepos;
}

function getNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) { return null; }
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}
