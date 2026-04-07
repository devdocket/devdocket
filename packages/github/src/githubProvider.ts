import * as vscode from 'vscode';
import { logger } from './logger';

// Re-declared to match core API contract — separate extension cannot import core types directly
interface Disposable {
  dispose(): void;
}

// Re-declared to match core API contract — separate extension cannot import core types directly
interface Event<T> {
  (listener: (e: T) => void): Disposable;
}

interface DiscoveredItem {
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  group?: string;
}

interface WorkCenterProvider {
  readonly id: string;
  readonly label: string;
  readonly resurfaceDismissed?: boolean;
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;
  refresh(token?: vscode.CancellationToken): Promise<void>;
}

interface GitHubIssue {
  number: number;
  title: string;
  body?: string;
  html_url: string;
  repository_url: string;
  pull_request?: unknown;
}

export class GitHubIssueProvider implements WorkCenterProvider {
  readonly id = 'github';
  readonly label = 'GitHub Issues';

  private readonly _onDidDiscoverItems = new vscode.EventEmitter<DiscoveredItem[]>();
  readonly onDidDiscoverItems = this._onDidDiscoverItems.event;

  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private _isRefreshing = false;

  startPeriodicRefresh(intervalSeconds: number): void {
    this.stopPeriodicRefresh();
    const interval = Number(intervalSeconds);
    if (!Number.isFinite(interval) || interval <= 0) {
      return;
    }
    // Clamp to minimum of 60 seconds
    const clampedInterval = Math.max(interval, 60);
    this.refreshTimer = setInterval(() => {
      this.refreshInBackground().catch((err: unknown) => {
        logger.error('Refresh failed', err);
      });
    }, clampedInterval * 1000);
  }

  stopPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async refresh(token?: vscode.CancellationToken): Promise<void> {
    if (this._isRefreshing) {
      return;
    }

    this._isRefreshing = true;
    logger.info('Fetching assigned issues...');
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
        vscode.window.showWarningMessage(`WorkCenter GitHub: Authentication failed — ${message}`);
        return;
      }

      if (!session || token?.isCancellationRequested) {
        if (!session) {
          logger.info('User cancelled GitHub authentication');
        }
        return;
      }

      await this.fetchAndPublishIssues(session.accessToken, true);
    } catch (err: unknown) {
      logger.error('Failed to fetch issues', err);
    } finally {
      this._isRefreshing = false;
    }
  }

  private async refreshInBackground(): Promise<void> {
    if (this._isRefreshing) {
      return;
    }

    this._isRefreshing = true;
    try {
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

      await this.fetchAndPublishIssues(session.accessToken, false);
    } catch (err: unknown) {
      logger.error('Failed to fetch issues', err);
    } finally {
      this._isRefreshing = false;
    }
  }

  private async fetchAndPublishIssues(accessToken: string, isUserTriggered: boolean = false): Promise<void> {
    const repos = this.getConfiguredRepos();
    const { issues, failures } = await this.fetchAssignedIssues(accessToken, repos);

    const items: DiscoveredItem[] = issues.map((issue) => {
      const repoName = this.parseRepo(issue);
      return {
        externalId: `${repoName}#${issue.number}`,
        title: `#${issue.number}: ${issue.title}`,
        description: issue.body?.slice(0, 200),
        url: issue.html_url,
        group: repoName,
      };
    });

    logger.info(`Discovered ${items.length} GitHub issues`);
    this._onDidDiscoverItems.fire(items);

    if (failures.length > 0) {
      const message = failures.length === 1
        ? `Failed to fetch issues from ${failures[0]}`
        : `Failed to fetch issues from ${failures.length} repositories`;
      if (isUserTriggered) {
        vscode.window.showWarningMessage(`WorkCenter GitHub: ${message}`);
      } else {
        logger.warn(message);
      }
    }
  }

  private getConfiguredRepos(): string[] {
    const config = vscode.workspace.getConfiguration('workcenterGithub');
    return config.get<string[]>('repos', []);
  }

  private parseRepo(issue: GitHubIssue): string {
    const match = issue.html_url.match(/github\.com\/([^/]+\/[^/]+)/);
    if (match) {
      return match[1];
    }
    
    // Fallback to parsing from repository_url (API URL)
    const apiMatch = issue.repository_url.match(/repos\/([^/]+\/[^/]+)/);
    if (apiMatch) {
      return apiMatch[1];
    }
    
    // Deterministic fallback: hash the repository_url
    const hash = issue.repository_url.split('').reduce((acc, char) => {
      return ((acc << 5) - acc) + char.charCodeAt(0) | 0;
    }, 0);
    return `unknown-repo-${Math.abs(hash).toString(36)}`;
  }

  private async fetchAssignedIssues(
    token: string,
    repos: string[],
  ): Promise<{ issues: GitHubIssue[]; failures: string[] }> {
    if (repos.length > 0) {
      const results = await Promise.allSettled(
        repos.map(repo => this.fetchRepoIssues(token, repo))
      );

      const allIssues: GitHubIssue[] = [];
      const failures: string[] = [];

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const { issues, failed } = result.value;
          allIssues.push(...issues);
          if (failed) {
            failures.push(repos[index]);
          }
        } else {
          failures.push(repos[index]);
        }
      });

      return { issues: allIssues, failures };
    }

    // Fallback: fetch all assigned issues across all repos
    const { issues, failed } = await this.fetchAllAssignedIssues(token);
    return { issues, failures: failed ? ['all repositories'] : [] };
  }

  private async fetchRepoIssues(token: string, repo: string): Promise<{ issues: GitHubIssue[]; failed: boolean }> {
    logger.debug(`Fetching issues for repo: ${repo}`);
    try {
      const items = await this.fetchPaginated<GitHubIssue>(
        `https://api.github.com/repos/${repo}/issues?assignee=@me&state=open&per_page=100`,
        token,
      );
      // Filter out pull requests (GitHub /issues endpoint returns both issues and PRs)
      const issues = items.filter(item => !item.pull_request);
      return { issues, failed: false };
    } catch (err) {
      logger.error(`Failed to fetch issues for ${repo}`, err);
      return { issues: [], failed: true };
    }
  }

  private async fetchAllAssignedIssues(token: string): Promise<{ issues: GitHubIssue[]; failed: boolean }> {
    try {
      const items = await this.fetchPaginated<GitHubIssue>(
        'https://api.github.com/issues?filter=assigned&state=open&per_page=100',
        token,
      );
      // Filter out pull requests (GitHub /issues endpoint returns both issues and PRs)
      const issues = items.filter(item => !item.pull_request);
      return { issues, failed: false };
    } catch (err) {
      logger.error('Failed to fetch assigned issues', err);
      return { issues: [], failed: true };
    }
  }

  private async fetchPaginated<T>(url: string, token: string, maxPages: number = 10): Promise<T[]> {
    const allItems: T[] = [];
    let nextUrl: string | null = url;
    let page = 0;

    while (nextUrl && page < maxPages) {
      let response: Response;
      try {
        response = await fetch(nextUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
      } catch (err) {
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

  dispose(): void {
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }
}
