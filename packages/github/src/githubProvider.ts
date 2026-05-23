import { ProviderItem, combineSignals, createAbortError, safeDecodeComponent, type ResolvedItem } from '@devdocket/shared';
import { BaseGitHubProvider } from './baseGithubProvider';
import { logger } from './logger';
import { parseRepoFromUrls } from './parseRepo';
import { getHeaders, getGitHubAuthHeaders, retryWithAuth, throwApiError, looksLikeRateLimited403, parseCanonicalRepo, fetchClosedGitHubItems, buildIssueStateBadge, type GitHubIssue } from './githubApiHelpers';
import { matchesRepoPatterns } from './repoPattern';
import { createGitHubIssueGitWork } from './gitWorkCapabilities';

/**
 * DevDocket provider that discovers GitHub issues assigned to the current user.
 *
 * Issues are always fetched globally via the GitHub REST API using VS Code's
 * built-in GitHub authentication. When filter patterns are configured, results
 * are post-filtered to exclude matching repositories.
 *
 * Supports periodic background refresh and emits discovered items through
 * the {@link DevDocketProvider.onDidDiscoverItems} event.
 */
export class GitHubIssueProvider extends BaseGitHubProvider {
  readonly id = 'github';
  readonly label = 'GitHub Issues';

  protected async fetchAndPublish(accessToken: string, isUserTriggered: boolean, signal?: AbortSignal): Promise<void> {
    logger.info('Fetching assigned issues...');
    const patterns = this.getConfiguredPatterns();

    const { issues, failed } = await this.fetchAllAssignedIssues(accessToken, signal);

    // Parse repo name once per issue, then filter and map
    const issuesWithRepo = issues.map(issue => ({
      issue,
      repoName: parseRepoFromUrls(issue.html_url, issue.repository_url),
    }));

    const filteredIssues = patterns.length > 0
      ? issuesWithRepo.filter(({ repoName }) => matchesRepoPatterns(repoName, patterns))
      : issuesWithRepo;

    const items: ProviderItem[] = filteredIssues.map(({ issue, repoName }) => {
      return {
        externalId: `${repoName}#${issue.number}`,
        title: `#${issue.number}: ${issue.title}`,
        description: issue.body ?? undefined,
        url: issue.html_url,
        ...(issue.user?.login ? {
          author: {
            displayName: issue.user.login,
            handle: issue.user.login,
            avatarUrl: issue.user.avatar_url,
            profileUrl: issue.user.html_url,
          },
        } : {}),
        group: repoName,
        reason: 'assigned',
        canonicalId: `github:issue:${repoName}#${issue.number}`,
        itemType: 'issue',
        capabilities: { gitWork: createGitHubIssueGitWork(repoName, issue.number) },
        badges: [
          { label: 'Assigned', variant: 'warning' },
          ...buildIssueStateBadge(issue.state),
        ],
        ...(issue.state ? { state: issue.state } : {}),
      };
    });

    logger.info(`Discovered ${items.length} GitHub issues`);
    this.publishProviderItems(items, patterns);

    if (failed) {
      this.warnOnFetchFailure('Failed to fetch assigned issues', isUserTriggered);
    }
  }

  private static readonly GITHUB_ISSUE_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\b/i;

  async resolveUrl(url: string, signal?: AbortSignal): Promise<ResolvedItem | undefined> {
    const match = url.trim().match(GitHubIssueProvider.GITHUB_ISSUE_PATTERN);
    if (!match) { return undefined; }
    const [, rawOwner, rawRepo, numStr] = match;
    const owner = safeDecodeComponent(rawOwner);
    const repo = safeDecodeComponent(rawRepo);
    const number = parseInt(numStr, 10);

    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
    const headers = await getHeaders();
    const wasAuthenticated = 'Authorization' in headers;

    let response = await fetch(apiUrl, { headers, signal });

    if (!response.ok && !wasAuthenticated && !signal?.aborted &&
        (response.status === 404 || looksLikeRateLimited403(response))) {
      const retryResponse = await retryWithAuth(apiUrl, signal, { interactive: true });
      if (retryResponse) { response = retryResponse; }
    }

    if (!response.ok) {
      await throwApiError(response, `GitHub issue ${owner}/${repo}#${number}`);
    }

    const data = await response.json() as { title: string; body: string | null; html_url: string };
    const canonicalRepo = parseCanonicalRepo(data.html_url, owner, repo);
    return {
      title: `#${number}: ${data.title}`,
      notes: data.body ?? '',
      url: data.html_url,
      externalId: `${canonicalRepo}#${number}`,
      group: canonicalRepo,
      providerId: this.id,
    };
  }

  /**
   * Check which of the given external IDs correspond to closed GitHub issues.
   */
  async getClosedItems(externalIds: string[], signal?: AbortSignal): Promise<string[]> {
    return fetchClosedGitHubItems(externalIds, 'issues', signal);
  }

  private async fetchAllAssignedIssues(token: string, signal?: AbortSignal): Promise<{ issues: GitHubIssue[]; failed: boolean }> {
    try {
      const items = await this.fetchPaginated<GitHubIssue>(
        'https://api.github.com/issues?filter=assigned&state=open&per_page=100',
        token,
        10,
        signal,
      );
      // Filter out pull requests (GitHub /issues endpoint returns both issues and PRs)
      const issues = items.filter(item => !item.pull_request);
      return { issues, failed: false };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) { throw err; }
      logger.error('Failed to fetch assigned issues', err);
      return { issues: [], failed: true };
    }
  }

  private async fetchPaginated<T>(url: string, token: string, maxPages: number = 10, signal?: AbortSignal): Promise<T[]> {
    const allItems: T[] = [];
    let nextUrl: string | null = url;
    let page = 0;

    while (nextUrl && page < maxPages) {
      if (signal?.aborted) {
        throw createAbortError();
      }
      let response: Response;
      try {
        response = await fetch(nextUrl, {
          headers: getGitHubAuthHeaders(token),
          signal: combineSignals(signal, 30_000),
        });
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }
        if (allItems.length > 0) {
          logger.warn(
            `Network error on page ${page + 1}. ` +
            `Returning ${allItems.length} items from previous pages.`,
            err,
          );
          return allItems;
        }
        throw err;
      }

      if (!response.ok) {
        if (allItems.length > 0) {
          logger.warn(
            `GitHub API returned ${response.status} on page ${page + 1}. ` +
            `Returning ${allItems.length} items from previous pages.`,
          );
          return allItems;
        }
        throw new Error(`GitHub API returned ${response.status}`);
      }

      const items = (await response.json()) as T[];
      allItems.push(...items);

      nextUrl = this.getNextPageUrl(response.headers.get('link'));
      page++;
    }

    if (nextUrl) {
      logger.warn(`Pagination limit reached (${maxPages} pages). Some items may not be shown.`);
    }

    return allItems;
  }

  private getNextPageUrl(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] : null;
  }

}
