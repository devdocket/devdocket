import * as vscode from 'vscode';

// Re-declared to match core API contract — separate extension cannot import core types directly
interface Disposable {
  dispose(): void;
}

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
  refresh(): Promise<void>;
}

interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  repository: {
    name: string;
    project: { name: string };
    webUrl: string;
  };
}

// Response from the ADO connection data API
interface ConnectionData {
  authenticatedUser: { id: string };
}

// Azure DevOps REST API scope for authentication
const ADO_AUTH_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

export class AdoPrReviewProvider implements WorkCenterProvider {
  readonly id = 'ado-pr-reviews';
  readonly label = 'Azure DevOps PR Reviews';
  readonly resurfaceDismissed = true;

  private readonly _onDidDiscoverItems = new vscode.EventEmitter<DiscoveredItem[]>();
  readonly onDidDiscoverItems = this._onDidDiscoverItems.event;

  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private _isRefreshing = false;
  private _cachedUserId: string | undefined;
  private _cachedSessionAccountId: string | undefined;

  constructor(
    private readonly org: string,
    private readonly projects: string[],
  ) {}

  startPeriodicRefresh(intervalSeconds: number): void {
    this.stopPeriodicRefresh();
    const interval = Number(intervalSeconds);
    if (!Number.isFinite(interval) || interval <= 0) {
      return;
    }
    const clampedInterval = Math.max(interval, 60);
    this.refreshTimer = setInterval(() => {
      this.refreshInBackground().catch((err) => {
        console.error('WorkCenter ADO: PR review refresh failed:', err);
      });
    }, clampedInterval * 1000);
  }

  stopPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async refresh(): Promise<void> {
    if (this._isRefreshing) {
      return;
    }

    this._isRefreshing = true;
    try {
      const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], {
        createIfNone: true,
      }).catch(() => null);

      if (!session) {
        return;
      }

      await this.fetchAndPublishPrs(session.accessToken, true, session.account.id);
    } catch (err) {
      console.error('WorkCenter ADO: failed to fetch PR reviews:', err);
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
      const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], {
        createIfNone: false,
      }).catch(() => null);

      if (!session) {
        return;
      }

      await this.fetchAndPublishPrs(session.accessToken, false, session.account.id);
    } catch (err) {
      console.error('WorkCenter ADO: failed to fetch PR reviews:', err);
    } finally {
      this._isRefreshing = false;
    }
  }

  private async fetchAndPublishPrs(accessToken: string, isUserTriggered: boolean, sessionAccountId: string): Promise<void> {
    const userId = await this.getUserId(accessToken, sessionAccountId);
    if (!userId) {
      const message = 'Failed to determine Azure DevOps user identity';
      if (isUserTriggered) {
        vscode.window.showWarningMessage(`WorkCenter ADO: ${message}`);
      } else {
        console.warn(`WorkCenter ADO: ${message}`);
      }
      this._onDidDiscoverItems.fire([]);
      return;
    }

    const projectList = this.projects.length > 0 ? this.projects : [''];
    const results = await Promise.allSettled(
      projectList.map(project => this.fetchPrsForProject(accessToken, project, userId)),
    );

    const allItems: DiscoveredItem[] = [];
    const failures: string[] = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const { items, failed } = result.value;
        allItems.push(...items);
        if (failed) {
          failures.push(projectList[index] || this.org);
        }
      } else {
        failures.push(projectList[index] || this.org);
      }
    });

    this._onDidDiscoverItems.fire(allItems);

    if (failures.length > 0) {
      const message = failures.length === 1
        ? `Failed to fetch PR reviews from ${failures[0]}`
        : `Failed to fetch PR reviews from ${failures.length} projects`;
      if (isUserTriggered) {
        vscode.window.showWarningMessage(`WorkCenter ADO: ${message}`);
      } else {
        console.warn(`WorkCenter ADO: ${message}`);
      }
    }
  }

  private async getUserId(token: string, sessionAccountId: string): Promise<string | undefined> {
    if (this._cachedUserId && this._cachedSessionAccountId === sessionAccountId) {
      return this._cachedUserId;
    }

    let response: Response;
    try {
      response = await fetch(
        `https://dev.azure.com/${encodeURIComponent(this.org)}/_apis/connectiondata?api-version=7.1`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch (err) {
      console.error('WorkCenter ADO: network error fetching connection data:', err);
      this._cachedUserId = undefined;
      this._cachedSessionAccountId = undefined;
      return undefined;
    }

    if (!response.ok) {
      console.error(`WorkCenter ADO: failed to fetch connection data: ${response.status}`);
      this._cachedUserId = undefined;
      this._cachedSessionAccountId = undefined;
      return undefined;
    }

    let data: ConnectionData;
    try {
      data = (await response.json()) as ConnectionData;
    } catch (err) {
      console.error('WorkCenter ADO: failed to parse connection data response:', err);
      this._cachedUserId = undefined;
      this._cachedSessionAccountId = undefined;
      return undefined;
    }

    if (!data?.authenticatedUser?.id) {
      this._cachedUserId = undefined;
      this._cachedSessionAccountId = undefined;
      return undefined;
    }

    this._cachedUserId = data.authenticatedUser.id;
    this._cachedSessionAccountId = sessionAccountId;
    return this._cachedUserId;
  }

  private async fetchPrsForProject(
    token: string,
    project: string,
    reviewerId: string,
  ): Promise<{ items: DiscoveredItem[]; failed: boolean }> {
    const projectPath = project ? `/${encodeURIComponent(project)}` : '';
    const url = `https://dev.azure.com/${encodeURIComponent(this.org)}${projectPath}/_apis/git/pullrequests?searchCriteria.reviewerId=${encodeURIComponent(reviewerId)}&searchCriteria.status=active&api-version=7.1`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      console.error(`WorkCenter ADO: failed to fetch PRs for project "${project}": ${response.status}`);
      return { items: [], failed: true };
    }

    let prData: { value: AdoPullRequest[] };
    try {
      prData = (await response.json()) as { value: AdoPullRequest[] };
    } catch (err) {
      console.error(`WorkCenter ADO: failed to parse PR response for project "${project}":`, err);
      return { items: [], failed: true };
    }
    const items: DiscoveredItem[] = prData.value.map((pr) => {
      const projectName = pr.repository.project.name;
      const repoName = pr.repository.name;
      return {
        externalId: `${projectName}/${repoName}/${pr.pullRequestId}`,
        title: `PR ${pr.pullRequestId}: ${pr.title}`,
        description: pr.description?.slice(0, 200),
        url: `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`,
        group: `${projectName}/${repoName}`,
      };
    });

    return { items, failed: false };
  }

  dispose(): void {
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }
}
