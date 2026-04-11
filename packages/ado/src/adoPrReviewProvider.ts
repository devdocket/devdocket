import * as vscode from 'vscode';
import { BaseProvider, DiscoveredItem, isValidUrlSegment } from '@workcenter/shared';
import { logger } from './logger';

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

/**
 * WorkCenter provider that discovers Azure DevOps pull requests where the
 * current user is listed as a reviewer.
 *
 * Uses the ADO Git Pull Requests API filtered by `reviewerId`. The user's
 * ADO identity is resolved from the connection data endpoint and cached for
 * subsequent refreshes.
 */
export class AdoPrReviewProvider extends BaseProvider {
  readonly id = 'ado-pr-reviews';
  readonly label = 'Azure DevOps PR Reviews';

  private _cachedUserId: string | undefined;
  private _cachedSessionAccountId: string | undefined;

  /**
   * @param org      - The Azure DevOps organisation name.
   * @param projects - Project names to query. An empty array queries the whole org.
   */
  constructor(
    private readonly org: string,
    private readonly projects: string[],
  ) {
    super(new vscode.EventEmitter<DiscoveredItem[]>());
  }

  /**
   * Performs a user-triggered refresh of PR review requests.
   * Prompts for authentication if no session exists.
   */
  async refresh(token?: vscode.CancellationToken): Promise<void> {
    if (this._isRefreshing) {
      return;
    }

    this._isRefreshing = true;
    try {
      logger.info('Fetching ADO PR reviews...');
      if (token?.isCancellationRequested) {
        this._onDidDiscoverItems.fire([]);
        return;
      }

      const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], {
        createIfNone: true,
      }).catch(() => null);

      if (!session || token?.isCancellationRequested) {
        this._onDidDiscoverItems.fire([]);
        return;
      }

      await this.fetchAndPublishPrs(session.accessToken, true, session.account.id);
    } catch (err) {
      this._onDidDiscoverItems.fire([]);
      logger.error('Failed to fetch PR reviews:', err);
    } finally {
      this._isRefreshing = false;
    }
  }

  protected async doBackgroundRefresh(): Promise<void> {
    try {
      logger.info('Fetching ADO PR reviews...');
      const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], {
        createIfNone: false,
      }).catch(() => null);

      if (!session) {
        this._onDidDiscoverItems.fire([]);
        return;
      }

      await this.fetchAndPublishPrs(session.accessToken, false, session.account.id);
    } catch (err) {
      this._onDidDiscoverItems.fire([]);
      logger.error('Failed to fetch PR reviews:', err);
    }
  }

  private async fetchAndPublishPrs(accessToken: string, isUserTriggered: boolean, sessionAccountId: string): Promise<void> {
    if (!isValidUrlSegment(this.org)) {
      logger.warn('Skipping PR fetch: invalid ADO organization name', this.org);
      this._onDidDiscoverItems.fire([]);
      return;
    }

    const userId = await this.getUserId(accessToken, sessionAccountId);
    if (!userId) {
      const message = 'Failed to determine Azure DevOps user identity';
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`WorkCenter ADO: ${message}`);
      }
      logger.warn(message);
      this._onDidDiscoverItems.fire([]);
      return;
    }

    const validProjects: string[] = [];
    for (const project of this.projects) {
      if (project === '' || isValidUrlSegment(project)) {
        validProjects.push(project);
      } else {
        logger.warn('Skipping invalid ADO project name', project);
      }
    }

    if (this.projects.length > 0 && validProjects.length === 0) {
      logger.warn('All configured ADO projects are invalid — skipping PR fetch');
      this._onDidDiscoverItems.fire([]);
      return;
    }

    const projectList = validProjects.length > 0 ? validProjects : [''];
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
        const target = projectList[index] || this.org;
        failures.push(target);
        logger.error(
          `Failed to fetch PR reviews from ${target}:`,
          (result as PromiseRejectedResult).reason,
        );
      }
    });

    this._onDidDiscoverItems.fire(allItems);
    logger.info(`Discovered ${allItems.length} ADO PR reviews`);

    if (failures.length > 0) {
      const message = failures.length === 1
        ? `Failed to fetch PR reviews from ${failures[0]}`
        : `Failed to fetch PR reviews from ${failures.length} projects`;
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`WorkCenter ADO: ${message}`);
      }
      logger.warn(message);
    }
  }

  private async getUserId(token: string, sessionAccountId: string): Promise<string | undefined> {
    if (this._cachedUserId && this._cachedSessionAccountId === sessionAccountId) {
      return this._cachedUserId;
    }

    let response: Response;
    try {
      response = await fetch(
        `https://dev.azure.com/${encodeURIComponent(this.org)}/_apis/connectiondata`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch (err) {
      logger.error('Network error fetching connection data:', err);
      this._cachedUserId = undefined;
      this._cachedSessionAccountId = undefined;
      return undefined;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.error(`Failed to fetch connection data: ${response.status} ${body}`);
      this._cachedUserId = undefined;
      this._cachedSessionAccountId = undefined;
      return undefined;
    }

    let data: ConnectionData;
    try {
      data = (await response.json()) as ConnectionData;
    } catch (err) {
      logger.error('Failed to parse connection data response:', err);
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
    logger.debug(`Resolved user ID: ${this._cachedUserId}`);
    return this._cachedUserId;
  }

  private async fetchPrsForProject(
    token: string,
    project: string,
    reviewerId: string,
  ): Promise<{ items: DiscoveredItem[]; failed: boolean }> {
    logger.debug(`Fetching PRs for project: ${project || this.org}`);
    const projectPath = project ? `/${encodeURIComponent(project)}` : '';
    const url = `https://dev.azure.com/${encodeURIComponent(this.org)}${projectPath}/_apis/git/pullrequests?searchCriteria.reviewerId=${encodeURIComponent(reviewerId)}&searchCriteria.status=active&api-version=7.1`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      logger.warn(`Failed to fetch PRs for project: ${project || this.org}`);
      logger.error(`PR fetch failed for project "${project}": ${response.status}`);
      return { items: [], failed: true };
    }

    let prData: { value: AdoPullRequest[] };
    try {
      prData = (await response.json()) as { value: AdoPullRequest[] };
    } catch (err) {
      logger.error(`Failed to parse PR response for project "${project}":`, err);
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
        reason: 'review_requested',
      };
    });

    return { items, failed: false };
  }


}
