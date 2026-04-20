import * as vscode from 'vscode';
import { logger } from './logger';
import { parseRepoFromUrls } from './parseRepo';
import { BaseGitHubProvider, DiscoveredItem, GitHubIssue, type ResolvedItem } from './baseGithubProvider';

interface GitHubSearchResponse {
  items: GitHubIssue[];
}

interface TimelineEvent {
  event?: string;
  created_at?: string;
  requested_reviewer?: { login?: string };
}

/**
 * DevDocket provider that discovers GitHub pull requests where the current
 * user has been requested as a reviewer.
 *
 * Uses the GitHub Search API (`review-requested:@me`) to find open PRs.
 */
export class GitHubPrReviewProvider extends BaseGitHubProvider {
  readonly id = 'github-pr-reviews';
  readonly label = 'GitHub PR Reviews';

  private _cachedCurrentUser: string | undefined;
  private _cachedCurrentUserToken: string | undefined;

  protected async fetchAndPublish(accessToken: string, isUserTriggered: boolean, signal?: AbortSignal): Promise<void> {
    logger.info('Fetching PR review requests...');
    const repos = this.getConfiguredRepos();
    const { prs, failures } = await this.fetchReviewRequestedPrs(accessToken, repos, signal);

    logger.info(`Discovered ${prs.length} PR review requests`);

    const config = vscode.workspace.getConfiguration('devdocketGithub');
    const resurfaceOnNewVersion = config.get<boolean>('resurfaceOnNewVersion', true);
    const resurfaceOnReRequestedReview = config.get<boolean>('resurfaceOnReRequestedReview', true);

    // Fetch head commit SHAs for precise version tracking
    const headShas = resurfaceOnNewVersion
      ? await this.fetchHeadShas(accessToken, prs, signal)
      : new Map<string, string>();

    // Fetch re-request timestamps for review re-request detection
    let reRequestTimes = new Map<string, string>();
    if (resurfaceOnReRequestedReview && prs.length > 0) {
      const currentUser = await this.fetchCurrentUser(accessToken, signal);
      if (currentUser) {
        reRequestTimes = await this.fetchReRequestTimes(accessToken, prs, currentUser, signal);
      }
    }

    const items: DiscoveredItem[] = prs.map((pr) => {
      const repoName = this.parseRepo(pr);
      const item: DiscoveredItem = {
        externalId: `${repoName}#${pr.number}`,
        title: `#${pr.number}: ${pr.title}`,
        description: pr.body?.slice(0, 200),
        url: pr.html_url,
        group: repoName,
        reason: 'review_requested',
      };
      if (pr.state) { item.state = pr.state; }
      const headSha = headShas.get(pr.html_url);
      if (headSha !== undefined) { item.version = headSha; }
      const reRequestTime = reRequestTimes.get(pr.html_url);
      if (reRequestTime !== undefined) { item.resurfaceVersion = reRequestTime; }
      return item;
    });

    this._onDidDiscoverItems.fire(items);

    if (failures.length > 0) {
      const message = failures.length === 1
        ? `Failed to fetch PR review requests from ${failures[0]}`
        : `Failed to fetch PR review requests from ${failures.length} repositories`;
      if (isUserTriggered) {
        vscode.window.showWarningMessage(`DevDocket GitHub: ${message}`);
      } else {
        logger.warn(message);
      }
    }
  }

  private static readonly GITHUB_PR_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\b/i;

  async resolveUrl(url: string, signal?: AbortSignal): Promise<ResolvedItem | undefined> {
    const match = url.trim().match(GitHubPrReviewProvider.GITHUB_PR_PATTERN);
    if (!match) { return undefined; }
    const [, rawOwner, rawRepo, numStr] = match;
    const owner = BaseGitHubProvider.safeDecodeComponent(rawOwner);
    const repo = BaseGitHubProvider.safeDecodeComponent(rawRepo);
    const number = parseInt(numStr, 10);

    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
    const headers = await this.getHeaders();
    const wasAuthenticated = 'Authorization' in headers;

    let response = await fetch(apiUrl, { headers, signal });

    if (response.status === 404 && !wasAuthenticated && !signal?.aborted) {
      const retryResponse = await this.retryWithAuth(apiUrl, signal);
      if (retryResponse) { response = retryResponse; }
    }

    if (!response.ok) {
      this.throwApiError(response, `GitHub PR ${owner}/${repo}#${number}`);
    }

    const data = await response.json() as { title: string; body: string | null; html_url: string };
    const canonicalRepo = this.parseCanonicalRepo(data.html_url, owner, repo);
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
   * Check which of the given external IDs correspond to closed/merged GitHub PRs.
   */
  async getClosedItems(externalIds: string[], signal?: AbortSignal): Promise<string[]> {
    return this.fetchClosedGitHubItems(externalIds, 'pulls', signal);
  }

  private getConfiguredRepos(): string[] {
    const config = vscode.workspace.getConfiguration('devdocketGithub');
    return config.get<string[]>('repos', []);
  }

  private async fetchReviewRequestedPrs(
    token: string,
    repos: string[],
    signal?: AbortSignal,
  ): Promise<{ prs: GitHubIssue[]; failures: string[] }> {
    if (repos.length > 0) {
      const results = await this.fetchRepoPrReviewsWithLimit(token, repos, 3, signal);

      const allPrs: GitHubIssue[] = [];
      const failures: string[] = [];

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const { prs: repoPrs, failed } = result.value;
          allPrs.push(...repoPrs);
          if (failed) {
            failures.push(repos[index]);
          }
        } else {
          failures.push(repos[index]);
        }
      });

      return { prs: allPrs, failures };
    }

    // Fallback: fetch all review-requested PRs across all repos
    const { prs, failed } = await this.fetchAllPrReviews(token, signal);
    return { prs, failures: failed ? ['all repositories'] : [] };
  }

  // Limit concurrent per-repo search API calls to avoid hitting rate limits
  private async fetchRepoPrReviewsWithLimit(
    token: string,
    repos: string[],
    maxConcurrent: number,
    signal?: AbortSignal,
  ): Promise<PromiseSettledResult<{ prs: GitHubIssue[]; failed: boolean }>[]> {
    const results: PromiseSettledResult<{ prs: GitHubIssue[]; failed: boolean }>[] = new Array(repos.length);
    let nextIndex = 0;

    const runWorker = async (): Promise<void> => {
      while (nextIndex < repos.length) {
        if (signal?.aborted) {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        const currentIndex = nextIndex++;
        try {
          const value = await this.fetchRepoPrReviews(token, repos[currentIndex], signal);
          results[currentIndex] = { status: 'fulfilled', value };
        } catch (reason) {
          if (reason instanceof Error && reason.name === 'AbortError') { throw reason; }
          results[currentIndex] = { status: 'rejected', reason: reason as Error };
        }
      }
    };

    const workerCount = Math.min(maxConcurrent, repos.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    return results;
  }

  private async fetchRepoPrReviews(token: string, repo: string, signal?: AbortSignal): Promise<{ prs: GitHubIssue[]; failed: boolean }> {
    logger.debug(`Fetching PR reviews for repo: ${repo}`);
    const response = await fetch(
      `https://api.github.com/search/issues?q=type:pr+state:open+review-requested:@me+repo:${repo}&per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal,
      },
    );

    if (!response.ok) {
      logger.error(`Failed to fetch PR reviews for ${repo}: ${response.status}`);
      return { prs: [], failed: true };
    }

    const data = (await response.json()) as GitHubSearchResponse;
    return { prs: data.items, failed: false };
  }

  private async fetchAllPrReviews(token: string, signal?: AbortSignal): Promise<{ prs: GitHubIssue[]; failed: boolean }> {
    const response = await fetch(
      'https://api.github.com/search/issues?q=type:pr+state:open+review-requested:@me&per_page=100',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal,
      },
    );

    if (!response.ok) {
      logger.error(`Failed to fetch PR review requests: ${response.status}`);
      return { prs: [], failed: true };
    }

    const data = (await response.json()) as GitHubSearchResponse;
    return { prs: data.items, failed: false };
  }

  /**
   * Fetches the HEAD commit SHA for each PR via the REST API.
   * Uses the `pull_request.url` from search results to avoid constructing URLs.
   * Best-effort: failures are logged at debug level and skipped (version will be undefined).
   */
  private async fetchHeadShas(token: string, prs: GitHubIssue[], signal?: AbortSignal): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const prsWithApiUrl = prs.filter(pr => pr.pull_request?.url);
    if (prsWithApiUrl.length === 0) {
      return result;
    }

    let nextIndex = 0;
    const runWorker = async (): Promise<void> => {
      while (nextIndex < prsWithApiUrl.length) {
        if (signal?.aborted) { break; }
        const currentIndex = nextIndex++;
        const pr = prsWithApiUrl[currentIndex];
        try {
          const response = await fetch(pr.pull_request!.url, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            signal,
          });
          if (response.ok) {
            const data = (await response.json()) as { head?: { sha?: string } };
            if (data.head?.sha) {
              result.set(pr.html_url, data.head.sha);
            }
          } else {
            logger.debug(
              `Failed to fetch head SHA for PR ${pr.html_url}: ${response.status} ${response.statusText}`,
            );
          }
        } catch (error) {
          if (signal?.aborted) { break; }
          logger.debug(`Failed to fetch head SHA for PR ${pr.html_url}: ${String(error)}`);
        }
      }
    };

    const workerCount = Math.min(3, prsWithApiUrl.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    return result;
  }

  /**
   * Fetches the authenticated user's login name. Cached for the lifetime of the provider.
   * Returns undefined on failure.
   */
  private async fetchCurrentUser(token: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this._cachedCurrentUser && this._cachedCurrentUserToken === token) {
      return this._cachedCurrentUser;
    }

    try {
      const response = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal,
      });
      if (response.ok) {
        const data = (await response.json()) as { login?: string };
        if (data.login) {
          this._cachedCurrentUser = data.login;
          this._cachedCurrentUserToken = token;
          return data.login;
        }
      }
      logger.debug(`Failed to fetch current user: ${response.status}`);
    } catch (error) {
      logger.debug(`Failed to fetch current user: ${String(error)}`);
    }
    return undefined;
  }

  /**
   * For each PR, fetches timeline events and finds the latest `review_requested`
   * event directed at the current user. Returns a map of PR html_url → timestamp.
   * Best-effort: failures are logged at debug level and skipped.
   */
  private async fetchReRequestTimes(
    token: string,
    prs: GitHubIssue[],
    currentUserLogin: string,
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    let nextIndex = 0;
    const runWorker = async (): Promise<void> => {
      while (nextIndex < prs.length) {
        if (signal?.aborted) { break; }
        const currentIdx = nextIndex++;
        const pr = prs[currentIdx];
        try {
          // Only fetches the first page (100 events). For PRs with very extensive
          // activity the latest review_requested event could be missed — an acceptable
          // trade-off to limit API calls.
          const timelineUrl = `${pr.repository_url}/issues/${pr.number}/timeline?per_page=100`;
          const response = await fetch(timelineUrl, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            signal,
          });
          if (response.ok) {
            const events = (await response.json()) as TimelineEvent[];
            let latestReRequest: string | undefined;
            for (const event of events) {
              if (
                event.event === 'review_requested' &&
                event.requested_reviewer?.login?.toLowerCase() === currentUserLogin.toLowerCase() &&
                event.created_at
              ) {
                // Track the maximum timestamp rather than relying on array order
                if (!latestReRequest || event.created_at > latestReRequest) {
                  latestReRequest = event.created_at;
                }
              }
            }
            if (latestReRequest) {
              result.set(pr.html_url, latestReRequest);
            }
          } else {
            logger.debug(
              `Failed to fetch timeline for PR ${pr.html_url}: ${response.status}`,
            );
          }
        } catch (error) {
          if (signal?.aborted) { break; }
          logger.debug(`Failed to fetch timeline for PR ${pr.html_url}: ${String(error)}`);
        }
      }
    };

    const workerCount = Math.min(3, prs.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    return result;
  }

  protected override parseRepo(issue: GitHubIssue): string {
    return parseRepoFromUrls(issue.html_url, issue.repository_url);
  }
}
