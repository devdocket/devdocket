import * as vscode from 'vscode';
import { logger } from './logger';
import { parseRepoFromUrls } from './parseRepo';
import { BaseGitHubProvider, DiscoveredItem, GitHubIssue } from './baseGithubProvider';

interface GitHubSearchResponse {
  items: GitHubIssue[];
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

  protected async fetchAndPublish(accessToken: string, isUserTriggered: boolean): Promise<void> {
    logger.info('Fetching PR review requests...');
    const repos = this.getConfiguredRepos();
    const { prs, failures } = await this.fetchReviewRequestedPrs(accessToken, repos);

    logger.info(`Discovered ${prs.length} PR review requests`);

    // Fetch head commit SHAs for precise version tracking
    const headShas = await this.fetchHeadShas(accessToken, prs);

    const items: DiscoveredItem[] = prs.map((pr) => {
      const repoName = this.parseRepo(pr);
      return {
        externalId: `${repoName}#${pr.number}`,
        title: `#${pr.number}: ${pr.title}`,
        description: pr.body?.slice(0, 200),
        url: pr.html_url,
        group: repoName,
        reason: 'review_requested',
        version: headShas.get(pr.html_url),
      };
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

  private getConfiguredRepos(): string[] {
    const config = vscode.workspace.getConfiguration('devdocketGithub');
    return config.get<string[]>('repos', []);
  }

  private async fetchReviewRequestedPrs(
    token: string,
    repos: string[],
  ): Promise<{ prs: GitHubIssue[]; failures: string[] }> {
    if (repos.length > 0) {
      const results = await this.fetchRepoPrReviewsWithLimit(token, repos, 3);

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
    const { prs, failed } = await this.fetchAllPrReviews(token);
    return { prs, failures: failed ? ['all repositories'] : [] };
  }

  // Limit concurrent per-repo search API calls to avoid hitting rate limits
  private async fetchRepoPrReviewsWithLimit(
    token: string,
    repos: string[],
    maxConcurrent: number,
  ): Promise<PromiseSettledResult<{ prs: GitHubIssue[]; failed: boolean }>[]> {
    const results: PromiseSettledResult<{ prs: GitHubIssue[]; failed: boolean }>[] = new Array(repos.length);
    let nextIndex = 0;

    const runWorker = async (): Promise<void> => {
      while (nextIndex < repos.length) {
        const currentIndex = nextIndex++;
        try {
          const value = await this.fetchRepoPrReviews(token, repos[currentIndex]);
          results[currentIndex] = { status: 'fulfilled', value };
        } catch (reason) {
          results[currentIndex] = { status: 'rejected', reason: reason as Error };
        }
      }
    };

    const workerCount = Math.min(maxConcurrent, repos.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    return results;
  }

  private async fetchRepoPrReviews(token: string, repo: string): Promise<{ prs: GitHubIssue[]; failed: boolean }> {
    logger.debug(`Fetching PR reviews for repo: ${repo}`);
    const response = await fetch(
      `https://api.github.com/search/issues?q=type:pr+state:open+review-requested:@me+repo:${repo}&per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      logger.error(`Failed to fetch PR reviews for ${repo}: ${response.status}`);
      return { prs: [], failed: true };
    }

    const data = (await response.json()) as GitHubSearchResponse;
    return { prs: data.items, failed: false };
  }

  private async fetchAllPrReviews(token: string): Promise<{ prs: GitHubIssue[]; failed: boolean }> {
    const response = await fetch(
      'https://api.github.com/search/issues?q=type:pr+state:open+review-requested:@me&per_page=100',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
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
  private async fetchHeadShas(token: string, prs: GitHubIssue[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const prsWithApiUrl = prs.filter(pr => pr.pull_request?.url);
    if (prsWithApiUrl.length === 0) {
      return result;
    }

    let nextIndex = 0;
    const runWorker = async (): Promise<void> => {
      while (nextIndex < prsWithApiUrl.length) {
        const currentIndex = nextIndex++;
        const pr = prsWithApiUrl[currentIndex];
        try {
          const response = await fetch(pr.pull_request!.url, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
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
          logger.debug(`Failed to fetch head SHA for PR ${pr.html_url}: ${String(error)}`);
        }
      }
    };

    const workerCount = Math.min(3, prsWithApiUrl.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    return result;
  }

  protected override parseRepo(issue: GitHubIssue): string {
    return parseRepoFromUrls(issue.html_url, issue.repository_url);
  }
}
