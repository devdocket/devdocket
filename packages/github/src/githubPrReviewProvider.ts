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
}

interface GitHubSearchResponse {
  items: GitHubIssue[];
}

export class GitHubPrReviewProvider implements WorkCenterProvider {
  readonly id = 'github-pr-reviews';
  readonly label = 'GitHub PR Reviews';
  readonly resurfaceDismissed = true;

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
      this.refreshInBackground().catch((err) => {
        logger.error('PR review refresh failed', err);
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
    logger.info('Fetching PR review requests...');
    try {
      if (token?.isCancellationRequested) {
        return;
      }

      const session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: true,
      }).catch(() => null);

      if (!session || token?.isCancellationRequested) {
        return;
      }

      await this.fetchAndPublishPrs(session.accessToken, true);
    } catch (err) {
      logger.error('Failed to fetch PR reviews', err);
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
      const session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: false,
      }).catch(() => null);

      if (!session) {
        return;
      }

      await this.fetchAndPublishPrs(session.accessToken, false);
    } catch (err) {
      logger.error('Failed to fetch PR reviews', err);
    } finally {
      this._isRefreshing = false;
    }
  }

  private async fetchAndPublishPrs(accessToken: string, isUserTriggered: boolean): Promise<void> {
    const response = await fetch(
      'https://api.github.com/search/issues?q=type:pr+state:open+review-requested:@me&per_page=100',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      const message = 'Failed to fetch PR review requests';
      if (isUserTriggered) {
        vscode.window.showWarningMessage(`WorkCenter GitHub: ${message}`);
      } else {
        logger.warn(`${message}: ${response.status}`);
      }
      return;
    }

    const data = (await response.json()) as GitHubSearchResponse;
    logger.info(`Discovered ${data.items.length} PR review requests`);
    const items: DiscoveredItem[] = data.items.map((pr) => {
      const repoName = this.parseRepo(pr);
      return {
        externalId: `${repoName}#${pr.number}`,
        title: `#${pr.number}: ${pr.title}`,
        description: pr.body?.slice(0, 200),
        url: pr.html_url,
        group: repoName,
      };
    });

    this._onDidDiscoverItems.fire(items);
  }

  private parseRepo(pr: GitHubIssue): string {
    const match = pr.html_url.match(/github\.com\/([^/]+\/[^/]+)/);
    if (match) {
      return match[1];
    }

    // Fallback to parsing from repository_url (API URL)
    const apiMatch = pr.repository_url.match(/repos\/([^/]+\/[^/]+)/);
    if (apiMatch) {
      return apiMatch[1];
    }

    // Fallback: use repository_url as-is to maintain unique externalId
    logger.warn(`Could not parse repo from PR URL: ${pr.html_url}`);
    return pr.repository_url;
  }

  dispose(): void {
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }
}
