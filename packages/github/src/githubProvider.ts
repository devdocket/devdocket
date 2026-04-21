import * as vscode from 'vscode';
import { BaseProvider, DiscoveredItem, isValidGitHubRepo, combineSignals, safeDecodeComponent, type ResolvedItem } from '@devdocket/shared';
import { logger } from './logger';
import { parseRepoFromUrls } from './parseRepo';
import { getHeaders, retryWithAuth, throwApiError, parseCanonicalRepo, parseRepoFromIssue, fetchClosedGitHubItems, type GitHubIssue } from './githubApiHelpers';

/**
 * DevDocket provider that discovers GitHub issues assigned to the current user.
 *
 * Issues are fetched via the GitHub REST API using VS Code's built-in GitHub
 * authentication. When configured repos are specified, only those repos are
 * queried; otherwise all assigned issues across GitHub are returned.
 *
 * Supports periodic background refresh and emits discovered items through
 * the {@link DevDocketProvider.onDidDiscoverItems} event.
 */
export class GitHubIssueProvider extends BaseProvider {
  readonly id = 'github';
  readonly label = 'GitHub Issues';

  constructor() {
    super(new vscode.EventEmitter<DiscoveredItem[]>());
    this.onBackgroundRefreshError = (error) => {
      logger.error(`${this.label} refresh failed`, error);
    };
  }

  async refresh(token?: vscode.CancellationToken): Promise<void> {
    if (this._isRefreshing) {
      return;
    }

    this._isRefreshing = true;
    const abortController = new AbortController();
    const cancelListener = token?.onCancellationRequested?.(() => abortController.abort());
    try {
      if (token?.isCancellationRequested) {
        return;
      }

      let session: vscode.AuthenticationSession | undefined;
      try {
        session = await vscode.authentication.getSession('github', ['repo'], {
          createIfNone: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('GitHub authentication failed', err);
        vscode.window.showWarningMessage(`DevDocket GitHub: Authentication failed — ${message}`);
        return;
      }

      if (!session || token?.isCancellationRequested) {
        if (!session) {
          logger.info('User cancelled GitHub authentication');
        }
        return;
      }

      await this.fetchAndPublish(session.accessToken, true, abortController.signal);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && abortController.signal.aborted && token?.isCancellationRequested) {
        logger.debug(`${this.label} fetch aborted due to cancellation`);
      } else {
        logger.error(`Failed to fetch ${this.label}`, err);
      }
    } finally {
      cancelListener?.dispose();
      this._isRefreshing = false;
    }
  }

  protected async doBackgroundRefresh(): Promise<void> {
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: false,
      });
    } catch (err) {
      logger.warn('GitHub authentication failed during background refresh', err);
      return;
    }

    if (!session) {
      logger.debug('No GitHub session available for background refresh');
      return;
    }

    await this.fetchAndPublish(session.accessToken, false);
  }

  private async fetchAndPublish(accessToken: string, isUserTriggered: boolean, signal?: AbortSignal): Promise<void> {
    logger.info('Fetching assigned issues...');
    const repos = this.getConfiguredRepos();
    const { issues, failures } = await this.fetchAssignedIssues(accessToken, repos, signal);

    const items: DiscoveredItem[] = issues.map((issue) => {
      const repoName = parseRepoFromUrls(issue.html_url, issue.repository_url);
      return {
        externalId: `${repoName}#${issue.number}`,
        title: `#${issue.number}: ${issue.title}`,
        description: issue.body?.slice(0, 200),
        url: issue.html_url,
        group: repoName,
        reason: 'assigned',
        ...(issue.state ? { state: issue.state } : {}),
      };
    });

    logger.info(`Discovered ${items.length} GitHub issues`);
    this._onDidDiscoverItems.fire(items);

    if (failures.length > 0) {
      const message = failures.length === 1
        ? `Failed to fetch issues from ${failures[0]}`
        : `Failed to fetch issues from ${failures.length} repositories`;
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`DevDocket GitHub: ${message}`);
      } else {
        logger.warn(message);
      }
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

    if (response.status === 404 && !wasAuthenticated && !signal?.aborted) {
      const retryResponse = await retryWithAuth(apiUrl, signal);
      if (retryResponse) { response = retryResponse; }
    }

    if (!response.ok) {
      throwApiError(response, `GitHub issue ${owner}/${repo}#${number}`);
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

  private getConfiguredRepos(): string[] {
    const config = vscode.workspace.getConfiguration('devdocketGithub');
    return config.get<string[]>('repos', []);
  }

  private async fetchAssignedIssues(
    token: string,
    repos: string[],
    signal?: AbortSignal,
  ): Promise<{ issues: GitHubIssue[]; failures: string[] }> {
    if (repos.length > 0) {
      const validRepos: string[] = [];
      for (const repo of repos) {
        if (isValidGitHubRepo(repo)) {
          validRepos.push(repo);
        } else {
          logger.warn('Skipping invalid repo identifier', repo);
        }
      }

      const failures: string[] = [];

      const results = await Promise.allSettled(
        validRepos.map(repo => this.fetchRepoIssues(token, repo, signal))
      );

      const allIssues: GitHubIssue[] = [];

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const { issues, failed } = result.value;
          allIssues.push(...issues);
          if (failed) {
            failures.push(validRepos[index]);
          }
        } else {
          failures.push(validRepos[index]);
        }
      });

      // Propagate cancellation so the refresh stops without publishing partial results
      const abortedResult = results.find(
        (r): r is PromiseRejectedResult =>
          r.status === 'rejected' && r.reason instanceof Error && r.reason.name === 'AbortError',
      );
      if (signal?.aborted || abortedResult) {
        const error = abortedResult?.reason ?? new Error('The operation was aborted.');
        if (error.name !== 'AbortError') { error.name = 'AbortError'; }
        throw error;
      }

      return { issues: allIssues, failures };
    }

    // Fallback: fetch all assigned issues across all repos
    const { issues, failed } = await this.fetchAllAssignedIssues(token, signal);
    return { issues, failures: failed ? ['all repositories'] : [] };
  }

  private static readonly REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

  private async fetchRepoIssues(token: string, repo: string, signal?: AbortSignal): Promise<{ issues: GitHubIssue[]; failed: boolean }> {
    logger.debug(`Fetching issues for repo: ${repo}`);
    if (!GitHubIssueProvider.REPO_PATTERN.test(repo)) {
      logger.error(`Invalid repo format, expected owner/name: ${repo}`);
      return { issues: [], failed: true };
    }
    try {
      const items = await this.fetchPaginated<GitHubIssue>(
        `https://api.github.com/repos/${repo}/issues?assignee=@me&state=open&per_page=100`,
        token,
        10,
        signal,
      );
      // Filter out pull requests (GitHub /issues endpoint returns both issues and PRs)
      const issues = items.filter(item => !item.pull_request);
      return { issues, failed: false };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) { throw err; }
      logger.error(`Failed to fetch issues for ${repo}`, err);
      return { issues: [], failed: true };
    }
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
            'X-GitHub-Api-Version': '2022-11-28',
          },
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
