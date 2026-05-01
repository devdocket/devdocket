import * as vscode from 'vscode';
import { DiscoveredItem, RelatedItemRef, combineSignals, createAbortError, runWorkerPool } from '@devdocket/shared';
import { BaseGitHubProvider } from './baseGithubProvider';
import { logger } from './logger';
import { parseRepoFromUrls } from './parseRepo';
import { getGitHubAuthHeaders, type GitHubIssue, type GitHubSearchResponse } from './githubApiHelpers';
import { matchesRepoPatterns } from './repoPattern';

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

interface PrMetadata {
  status?: string;
  relatedItems?: RelatedItemRef[];
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface CrossReferencedTimelineResponse {
  repository?: {
    pullRequest?: {
      timelineItems?: {
        nodes?: Array<{
          willCloseTarget?: boolean;
          source?: {
            __typename?: string;
            number?: number;
            repository?: { nameWithOwner?: string };
          };
        }>;
      };
    };
  };
}

/**
 * DevDocket provider that discovers GitHub pull requests authored by or
 * assigned to the current user and surfaces their review/CI status.
 *
 * Uses the GitHub Search API (`author:@me` and `assignee:@me`) to find
 * open PRs, deduplicates self-authored PRs from assigned results, then
 * enriches each with review decisions and mergeable state via the PR
 * detail and reviews REST endpoints.
 *
 * Status values: Open (fallback when detailed PR/review status cannot be
 * determined), Draft, Waiting on reviews, Review received,
 * Changes requested, Approved, Ready to merge.
 */
export class GitHubMyPrsProvider extends BaseGitHubProvider {
  readonly id = 'github-my-prs';
  readonly label = 'My GitHub PRs';

  protected async fetchAndPublish(accessToken: string, isUserTriggered: boolean, signal?: AbortSignal): Promise<void> {
    logger.info('Fetching authored and assigned PRs...');
    const patterns = this.getConfiguredPatterns();

    // Fetch authored and assigned PRs in parallel; proceed with partial results if one fails
    const [authoredSettled, assignedSettled] = await Promise.allSettled([
      this.fetchPrsByFilter(accessToken, 'author', signal),
      this.fetchPrsByFilter(accessToken, 'assignee', signal),
    ]);

    const authoredResult = authoredSettled.status === 'fulfilled'
      ? authoredSettled.value
      : { prs: [] as GitHubIssue[], failures: [] as string[] };
    const assignedResult = assignedSettled.status === 'fulfilled'
      ? assignedSettled.value
      : { prs: [] as GitHubIssue[], failures: [] as string[] };

    if (authoredSettled.status === 'rejected') {
      const err = authoredSettled.reason;
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      logger.error('Failed to fetch authored PRs', err);
    }
    if (assignedSettled.status === 'rejected') {
      const err = assignedSettled.reason;
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      logger.error('Failed to fetch assigned PRs', err);
    }

    // Filter out self-authored PRs from assigned results to avoid duplicates
    const authoredUrls = new Set(authoredResult.prs.map(pr => pr.html_url));
    const uniqueAssignedPrs = assignedResult.prs.filter(pr => !authoredUrls.has(pr.html_url));

    // Parse repo name once per PR
    const allPrsList = [...authoredResult.prs, ...uniqueAssignedPrs];
    const repoNameMap = new Map(allPrsList.map(pr =>
      [pr.html_url, parseRepoFromUrls(pr.html_url, pr.repository_url)]
    ));

    // Post-filter when patterns are configured
    const repoFilter = (pr: GitHubIssue) => matchesRepoPatterns(repoNameMap.get(pr.html_url)!, patterns);
    const filteredAuthored = patterns.length > 0
      ? authoredResult.prs.filter(repoFilter)
      : authoredResult.prs;
    const filteredAssigned = patterns.length > 0
      ? uniqueAssignedPrs.filter(repoFilter)
      : uniqueAssignedPrs;

    logger.info(`Discovered ${filteredAuthored.length} authored PRs and ${filteredAssigned.length} assigned PRs`);

    const allPrs = [...filteredAuthored, ...filteredAssigned];

    const metadataMap = allPrs.length > 0
      ? await this.fetchPrMetadata(accessToken, allPrs, repoNameMap, signal)
      : new Map<string, PrMetadata>();

    const items: DiscoveredItem[] = [];
    for (const pr of filteredAuthored) {
      const repoName = repoNameMap.get(pr.html_url)!;
      const metadata = metadataMap.get(pr.html_url);
      items.push({
        externalId: `${repoName}#${pr.number}`,
        title: `#${pr.number}: ${pr.title}`,
        description: pr.body ?? undefined,
        url: pr.html_url,
        authored: true,
        group: repoName,
        reason: 'You authored this PR',
        state: metadata?.status ?? 'Open',
        canonicalId: `github:pull:${repoName}#${pr.number}`,
        relatedItems: metadata?.relatedItems,
      });
    }
    for (const pr of filteredAssigned) {
      const repoName = repoNameMap.get(pr.html_url)!;
      const metadata = metadataMap.get(pr.html_url);
      items.push({
        externalId: `${repoName}#${pr.number}`,
        title: `#${pr.number}: ${pr.title}`,
        description: pr.body ?? undefined,
        url: pr.html_url,
        group: repoName,
        reason: 'You are assigned to this PR',
        state: metadata?.status ?? 'Open',
        canonicalId: `github:pull:${repoName}#${pr.number}`,
        relatedItems: metadata?.relatedItems,
      });
    }

    this._onDidDiscoverItems.fire(items);

    const failures = [...new Set([...authoredResult.failures, ...assignedResult.failures])];
    if (failures.length > 0) {
      const message = 'Failed to fetch PRs';
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`DevDocket GitHub: ${message}`);
      } else {
        logger.warn(message);
      }
    }
  }

  private async fetchPrsByFilter(
    token: string,
    filter: 'author' | 'assignee',
    signal?: AbortSignal,
  ): Promise<{ prs: GitHubIssue[]; failures: string[] }> {
    const label = filter === 'author' ? 'authored' : 'assigned';
    const searchLabel = `${label} PR search`;
    let response: Response;
    try {
      response = await fetch(
        `https://api.github.com/search/issues?q=type:pr+state:open+${filter}:@me&per_page=100`,
        {
          headers: getGitHubAuthHeaders(token),
          signal: combineSignals(signal, 30_000),
        },
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') { throw err; }
      logger.error(`Failed to fetch ${label} PRs`, err);
      return { prs: [], failures: [searchLabel] };
    }

    if (!response.ok) {
      logger.error(`Failed to fetch ${label} PRs: ${response.status}`);
      return { prs: [], failures: [searchLabel] };
    }

    const data = (await response.json()) as GitHubSearchResponse;
    return { prs: data.items, failures: [] };
  }

  /**
   * Fetches PR details, reviews, and related issue references for each PR.
   * Uses concurrent workers to limit API call rate.
   */
  private async fetchPrMetadata(
    token: string,
    prs: GitHubIssue[],
    repoNameMap: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<Map<string, PrMetadata>> {
    const result = new Map<string, PrMetadata>();
    const prsWithApiUrl = prs.filter(pr => pr.pull_request?.url);
    if (prsWithApiUrl.length === 0) {
      return result;
    }

    await runWorkerPool(prsWithApiUrl, async (pr) => {
      if (signal?.aborted) {
        throw createAbortError();
      }
      try {
        const repoName = repoNameMap.get(pr.html_url);
        if (!repoName) {
          return;
        }
        const metadata = await this.fetchSinglePrMetadata(token, pr, repoName, signal);
        result.set(pr.html_url, metadata);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError' && signal?.aborted) { throw error; }
        logger.debug(`Failed to fetch metadata for PR ${pr.html_url}: ${String(error)}`);
      }
    }, 3);

    return result;
  }

  private async fetchSinglePrMetadata(
    token: string,
    pr: GitHubIssue,
    repoName: string,
    signal?: AbortSignal,
  ): Promise<PrMetadata> {
    const headers = getGitHubAuthHeaders(token);

    // Fetch PR details (draft, mergeable state)
    const detailResponse = await fetch(pr.pull_request!.url, { headers, signal: combineSignals(signal, 30_000) });
    if (!detailResponse.ok) {
      logger.debug(`Failed to fetch PR detail for ${pr.html_url}: ${detailResponse.status}`);
      return {};
    }
    const detail = (await detailResponse.json()) as PrDetail;

    // Fetch reviews — treat failure as unknown status since we can't determine
    // the actual review state without this data
    const reviewsUrl = `${pr.pull_request!.url}/reviews`;
    const reviewsResponse = await fetch(reviewsUrl, { headers, signal: combineSignals(signal, 30_000) });
    if (!reviewsResponse.ok) {
      logger.debug(`Failed to fetch reviews for ${pr.html_url}: ${reviewsResponse.status}`);
      return {};
    }
    const reviews = (await reviewsResponse.json()) as PrReview[];

    let relatedItems: RelatedItemRef[] | undefined;
    try {
      relatedItems = await this.fetchRelatedItems(token, repoName, pr.number, signal);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError' && signal?.aborted) {
        throw error;
      }
      logger.debug(`Failed to fetch related items for PR ${pr.html_url}: ${String(error)}`);
    }

    return {
      status: GitHubMyPrsProvider.determinePrStatus(detail, reviews),
      relatedItems,
    };
  }

  private async fetchRelatedItems(
    token: string,
    repoName: string,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<RelatedItemRef[] | undefined> {
    if (!repoName.includes('/')) {
      logger.debug(`Skipping cross-reference query for invalid repo name: ${repoName}`);
      return undefined;
    }
    const [owner, repo] = repoName.split('/');
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        ...getGitHubAuthHeaders(token),
        'Content-Type': 'application/json',
      },
      signal: combineSignals(signal, 30_000),
      body: JSON.stringify({
        query: `query RelatedItems($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              timelineItems(itemTypes: CROSS_REFERENCED_EVENT, first: 100) {
                nodes {
                  ... on CrossReferencedEvent {
                    willCloseTarget
                    source {
                      __typename
                      ... on Issue {
                        number
                        repository {
                          nameWithOwner
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        variables: { owner, name: repo, number: prNumber },
      }),
    });

    if (!response.ok) {
      logger.debug(`Failed to fetch related items for ${repoName}#${prNumber}: ${response.status}`);
      return undefined;
    }

    const data = (await response.json()) as GraphQlResponse<CrossReferencedTimelineResponse>;
    if (data.errors && data.errors.length > 0) {
      logger.debug(`GraphQL returned errors for ${repoName}#${prNumber}: ${data.errors.map(error => error.message).join(', ')}`);
      return undefined;
    }

    const links = new Map<string, RelatedItemRef>();
    for (const node of data.data?.repository?.pullRequest?.timelineItems?.nodes ?? []) {
      if (node.source?.__typename !== 'Issue') {
        continue;
      }
      const nameWithOwner = node.source.repository?.nameWithOwner;
      const number = node.source.number;
      if (!nameWithOwner || typeof number !== 'number') {
        continue;
      }

      const externalId = `${nameWithOwner}#${number}`;
      const relation: RelatedItemRef['relation'] = node.willCloseTarget ? 'closes' : 'linked';
      const existing = links.get(externalId);
      if (!existing || relation === 'closes') {
        links.set(externalId, { externalId, relation });
      }
    }

    return links.size > 0 ? [...links.values()] : undefined;
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
}
