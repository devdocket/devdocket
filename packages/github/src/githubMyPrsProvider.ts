import * as vscode from 'vscode';
import { logger } from './logger';
import { parseRepoFromUrls } from './parseRepo';
import { BaseGitHubProvider, DiscoveredItem, GitHubIssue } from './baseGithubProvider';

interface GitHubSearchResponse {
  items: GitHubIssue[];
}

export interface PrDetail {
  draft?: boolean;
  head?: { sha?: string };
  mergeable_state?: string;
}

export interface PrReview {
  user?: { id?: number; login?: string };
  state?: string;
  submitted_at?: string;
}

/**
 * DevDocket provider that discovers GitHub pull requests authored by the
 * current user and surfaces their review/CI status.
 *
 * Uses the GitHub Search API (`author:@me`) to find open PRs, then enriches
 * each with review decisions and mergeable state via the PR detail and
 * reviews REST endpoints.
 *
 * Status values: Open (fallback when detailed PR/review status cannot be
 * determined), Draft, Waiting on reviews, Review received,
 * Changes requested, Approved, Ready to merge.
 */
export class GitHubMyPrsProvider extends BaseGitHubProvider {
  readonly id = 'github-my-prs';
  readonly label = 'My GitHub PRs';

  protected async fetchAndPublish(accessToken: string, isUserTriggered: boolean, signal?: AbortSignal): Promise<void> {
    logger.info('Fetching authored PRs...');
    const repos = this.getConfiguredRepos();
    const { prs, failures } = await this.fetchAuthoredPrs(accessToken, repos, signal);

    logger.info(`Discovered ${prs.length} authored PRs`);

    const statusMap = prs.length > 0
      ? await this.fetchPrStatuses(accessToken, prs, signal)
      : new Map<string, string>();

    const items: DiscoveredItem[] = prs.map((pr) => {
      const repoName = this.parseRepo(pr);
      const status = statusMap.get(pr.html_url) ?? 'Open';
      return {
        externalId: `${repoName}#${pr.number}`,
        title: `#${pr.number}: ${pr.title}`,
        description: pr.body?.slice(0, 200),
        url: pr.html_url,
        group: repoName,
        reason: 'authored',
        state: status,
      };
    });

    this._onDidDiscoverItems.fire(items);

    if (failures.length > 0) {
      const message = failures.length === 1
        ? `Failed to fetch authored PRs from ${failures[0]}`
        : `Failed to fetch authored PRs from ${failures.length} repositories`;
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`DevDocket GitHub: ${message}`);
      } else {
        logger.warn(message);
      }
    }
  }

  private getConfiguredRepos(): string[] {
    const config = vscode.workspace.getConfiguration('devdocketGithub');
    return config.get<string[]>('repos', []);
  }

  private async fetchAuthoredPrs(
    token: string,
    repos: string[],
    signal?: AbortSignal,
  ): Promise<{ prs: GitHubIssue[]; failures: string[] }> {
    if (repos.length > 0) {
      return this.fetchPerRepoPrs(token, repos, signal);
    }
    return this.fetchAllAuthoredPrs(token, signal);
  }

  private async fetchPerRepoPrs(
    token: string,
    repos: string[],
    signal?: AbortSignal,
  ): Promise<{ prs: GitHubIssue[]; failures: string[] }> {
    const results: PromiseSettledResult<{ prs: GitHubIssue[]; failed: boolean }>[] = new Array(repos.length);
    let nextIndex = 0;

    const runWorker = async (): Promise<void> => {
      while (nextIndex < repos.length) {
        if (signal?.aborted) { break; }
        const currentIndex = nextIndex++;
        try {
          const value = await this.fetchRepoPrs(token, repos[currentIndex], signal);
          results[currentIndex] = { status: 'fulfilled', value };
        } catch (reason) {
          results[currentIndex] = { status: 'rejected', reason: reason as Error };
        }
      }
    };

    const workerCount = Math.min(3, repos.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    const allPrs: GitHubIssue[] = [];
    const failures: string[] = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allPrs.push(...result.value.prs);
        if (result.value.failed) {
          failures.push(repos[index]);
        }
      } else {
        failures.push(repos[index]);
      }
    });

    return { prs: allPrs, failures };
  }

  private async fetchRepoPrs(token: string, repo: string, signal?: AbortSignal): Promise<{ prs: GitHubIssue[]; failed: boolean }> {
    logger.debug(`Fetching authored PRs for repo: ${repo}`);
    const response = await fetch(
      `https://api.github.com/search/issues?q=type:pr+state:open+author:@me+repo:${repo}&per_page=100`,
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
      logger.error(`Failed to fetch authored PRs for ${repo}: ${response.status}`);
      return { prs: [], failed: true };
    }

    const data = (await response.json()) as GitHubSearchResponse;
    return { prs: data.items, failed: false };
  }

  private async fetchAllAuthoredPrs(token: string, signal?: AbortSignal): Promise<{ prs: GitHubIssue[]; failures: string[] }> {
    const response = await fetch(
      'https://api.github.com/search/issues?q=type:pr+state:open+author:@me&per_page=100',
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
      logger.error(`Failed to fetch authored PRs: ${response.status}`);
      return { prs: [], failures: ['all repositories'] };
    }

    const data = (await response.json()) as GitHubSearchResponse;
    return { prs: data.items, failures: [] };
  }

  /**
   * Fetches PR details and reviews for each PR to determine its status.
   * Uses concurrent workers to limit API call rate.
   */
  private async fetchPrStatuses(token: string, prs: GitHubIssue[], signal?: AbortSignal): Promise<Map<string, string>> {
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
          const status = await this.fetchSinglePrStatus(token, pr, signal);
          if (status) {
            result.set(pr.html_url, status);
          }
        } catch (error) {
          if (signal?.aborted) { break; }
          logger.debug(`Failed to fetch status for PR ${pr.html_url}: ${String(error)}`);
        }
      }
    };

    const workerCount = Math.min(3, prsWithApiUrl.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    return result;
  }

  private async fetchSinglePrStatus(token: string, pr: GitHubIssue, signal?: AbortSignal): Promise<string | undefined> {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    // Fetch PR details (draft, mergeable state)
    const detailResponse = await fetch(pr.pull_request!.url, { headers, signal });
    if (!detailResponse.ok) {
      logger.debug(`Failed to fetch PR detail for ${pr.html_url}: ${detailResponse.status}`);
      return undefined;
    }
    const detail = (await detailResponse.json()) as PrDetail;

    // Fetch reviews — treat failure as unknown status since we can't determine
    // the actual review state without this data
    const reviewsUrl = `${pr.pull_request!.url}/reviews`;
    const reviewsResponse = await fetch(reviewsUrl, { headers, signal });
    if (!reviewsResponse.ok) {
      logger.debug(`Failed to fetch reviews for ${pr.html_url}: ${reviewsResponse.status}`);
      return undefined;
    }
    const reviews = (await reviewsResponse.json()) as PrReview[];

    return GitHubMyPrsProvider.determinePrStatus(detail, reviews);
  }

  /**
   * Determines the PR status based on PR detail and review information.
   *
   * Priority:
   * 1. Draft → "Draft"
   * 2. Any latest-per-reviewer CHANGES_REQUESTED → "Changes requested"
   * 3. Any APPROVED + mergeable_state clean → "Ready to merge"
   * 4. Any APPROVED → "Approved"
   * 5. Any non-PENDING reviews → "Review received"
   * 6. No reviews → "Waiting on reviews"
   */
  static determinePrStatus(detail: PrDetail, reviews: PrReview[]): string {
    if (detail.draft) {
      return 'Draft';
    }

    // Build a map of latest review decision per reviewer (by user ID).
    // APPROVED, CHANGES_REQUESTED, and DISMISSED are tracked;
    // COMMENTED and PENDING are informational only.
    // A DISMISSED review neutralizes the reviewer's previous decision.
    const latestByReviewer = new Map<number, PrReview>();
    for (const review of reviews) {
      const userId = review.user?.id;
      if (userId === undefined || !review.state) {
        continue;
      }
      if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED' && review.state !== 'DISMISSED') {
        continue;
      }

      const existing = latestByReviewer.get(userId);
      const reviewSubmittedAt = review.submitted_at ?? '';
      const existingSubmittedAt = existing?.submitted_at ?? '';
      if (!existing || reviewSubmittedAt > existingSubmittedAt) {
        latestByReviewer.set(userId, review);
      }
    }

    // Filter out reviewers whose latest decision is DISMISSED (clears prior decision)
    const decisions = [...latestByReviewer.values()].filter(r => r.state !== 'DISMISSED');
    const hasChangesRequested = decisions.some(r => r.state === 'CHANGES_REQUESTED');
    const hasApproval = decisions.some(r => r.state === 'APPROVED');

    if (hasChangesRequested) {
      return 'Changes requested';
    }

    if (hasApproval) {
      if (detail.mergeable_state === 'clean') {
        return 'Ready to merge';
      }
      return 'Approved';
    }

    // Check for any non-PENDING review activity (comments, dismissed, etc.)
    const hasAnyReviews = reviews.some(r => r.state && r.state !== 'PENDING');
    if (hasAnyReviews) {
      return 'Review received';
    }

    return 'Waiting on reviews';
  }

  protected override parseRepo(issue: GitHubIssue): string {
    return parseRepoFromUrls(issue.html_url, issue.repository_url);
  }
}
