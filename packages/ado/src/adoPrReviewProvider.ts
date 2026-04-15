import * as vscode from 'vscode';
import { BaseProvider, DiscoveredItem, isValidUrlSegment } from '@devdocket/shared';
import { logger } from './logger';
import { OrgConfig } from './configParser';

interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  repository: {
    name: string;
    project: { name: string };
    webUrl?: string;
  };
  lastMergeSourceCommit?: {
    commitId: string;
  };
}

// Response from the ADO connection data API
interface ConnectionData {
  authenticatedUser: { id: string };
}

// Azure DevOps REST API scope for authentication
const ADO_AUTH_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

/**
 * DevDocket provider that discovers Azure DevOps pull requests where the
 * current user is listed as a reviewer.
 *
 * Uses the ADO Git Pull Requests API filtered by `reviewerId`. The user's
 * ADO identity is resolved from the connection data endpoint and cached for
 * subsequent refreshes.
 */
export class AdoPrReviewProvider extends BaseProvider {
  readonly id = 'ado-pr-reviews';
  readonly label = 'Azure DevOps PR Reviews';

  private _cachedUserIds = new Map<string, string>();
  private _cachedSessionAccountId: string | undefined;

  /**
   * @param orgConfigs - One or more organization configurations to query.
   */
  constructor(
    private readonly orgConfigs: OrgConfig[],
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
    const allItems: DiscoveredItem[] = [];
    const identityFailures: string[] = [];
    const fetchFailures: string[] = [];

    for (const orgConfig of this.orgConfigs) {
      if (!isValidUrlSegment(orgConfig.org)) {
        logger.warn('Skipping PR fetch: invalid ADO organization name', orgConfig.org);
        continue;
      }

      const userId = await this.getUserId(accessToken, orgConfig.org, sessionAccountId);
      if (!userId) {
        identityFailures.push(orgConfig.org);
        logger.warn(`Failed to determine Azure DevOps user identity for org ${orgConfig.org}`);
        continue;
      }

      const validProjects: string[] = [];
      for (const project of orgConfig.projects) {
        if (project === '' || isValidUrlSegment(project)) {
          validProjects.push(project);
        } else {
          logger.warn('Skipping invalid ADO project name', project);
        }
      }

      if (orgConfig.projects.length > 0 && validProjects.length === 0) {
        logger.warn(`All configured ADO projects are invalid for org ${orgConfig.org} — skipping PR fetch`);
        continue;
      }

      const projectList = validProjects.length > 0 ? validProjects : [''];
      const results = await Promise.allSettled(
        projectList.map(project => this.fetchPrsForProject(accessToken, orgConfig.org, project, userId)),
      );

      results.forEach((result, index) => {
        const project = projectList[index];
        const target = project ? `${orgConfig.org}/${project}` : orgConfig.org;

        if (result.status === 'fulfilled') {
          const { items, failed } = result.value;
          allItems.push(...items);
          if (failed) {
            fetchFailures.push(target);
          }
        } else {
          fetchFailures.push(target);
          logger.error(
            `Failed to fetch PR reviews from ${target}:`,
            (result as PromiseRejectedResult).reason,
          );
        }
      });
    }

    this._onDidDiscoverItems.fire(allItems);
    logger.info(`Discovered ${allItems.length} ADO PR reviews`);

    const messages: string[] = [];
    if (identityFailures.length > 0) {
      messages.push(`user identity failed for ${identityFailures.join(', ')}`);
    }
    if (fetchFailures.length > 0) {
      messages.push(
        fetchFailures.length === 1
          ? `failed to fetch from ${fetchFailures[0]}`
          : `failed to fetch from ${fetchFailures.length} sources`,
      );
    }
    if (messages.length > 0) {
      const message = `PR review errors: ${messages.join('; ')}`;
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`DevDocket ADO: ${message}`);
      }
      logger.warn(message);
    }
  }

  private async getUserId(token: string, org: string, sessionAccountId: string): Promise<string | undefined> {
    // If the auth account changed, clear all cached user IDs
    if (this._cachedSessionAccountId !== sessionAccountId) {
      this._cachedUserIds.clear();
      this._cachedSessionAccountId = sessionAccountId;
    }

    const cached = this._cachedUserIds.get(org);
    if (cached) {
      return cached;
    }

    let response: Response;
    try {
      response = await fetch(
        `https://dev.azure.com/${encodeURIComponent(org)}/_apis/connectiondata`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch (err) {
      logger.error(`Network error fetching connection data for org ${org}:`, err);
      this._cachedUserIds.delete(org);
      return undefined;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.error(`Failed to fetch connection data for org ${org}: ${response.status} ${body}`);
      this._cachedUserIds.delete(org);
      return undefined;
    }

    let data: ConnectionData;
    try {
      data = (await response.json()) as ConnectionData;
    } catch (err) {
      logger.error(`Failed to parse connection data response for org ${org}:`, err);
      this._cachedUserIds.delete(org);
      return undefined;
    }

    if (!data?.authenticatedUser?.id) {
      this._cachedUserIds.delete(org);
      return undefined;
    }

    this._cachedUserIds.set(org, data.authenticatedUser.id);
    logger.debug(`Resolved user ID for org ${org}: ${data.authenticatedUser.id}`);
    return data.authenticatedUser.id;
  }

  private async fetchPrsForProject(
    token: string,
    org: string,
    project: string,
    reviewerId: string,
  ): Promise<{ items: DiscoveredItem[]; failed: boolean }> {
    logger.debug(`Fetching PRs for project: ${project || org}`);
    const projectPath = project ? `/${encodeURIComponent(project)}` : '';
    const url = `https://dev.azure.com/${encodeURIComponent(org)}${projectPath}/_apis/git/pullrequests?searchCriteria.reviewerId=${encodeURIComponent(reviewerId)}&searchCriteria.status=active&api-version=7.1`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const target = project || org;
      logger.warn(`Failed to fetch PRs for ${target}`);
      logger.error(`PR fetch failed for ${target}: ${response.status}`);
      return { items: [], failed: true };
    }

    let prData: { value: AdoPullRequest[] };
    try {
      prData = (await response.json()) as { value: AdoPullRequest[] };
    } catch (err) {
      logger.error(`Failed to parse PR response for ${project || org}:`, err);
      return { items: [], failed: true };
    }
    const items: DiscoveredItem[] = prData.value.map((pr) => {
      const projectName = pr.repository.project.name;
      const repoName = pr.repository.name;
      const repoUrl = pr.repository.webUrl ?? `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repoName)}`;
      return {
        externalId: `${org}/${projectName}/${repoName}/${pr.pullRequestId}`,
        title: `PR ${pr.pullRequestId}: ${pr.title}`,
        description: pr.description?.slice(0, 200),
        url: `${repoUrl}/pullrequest/${pr.pullRequestId}`,
        group: `${projectName}/${repoName}`,
        reason: 'review_requested',
        version: pr.lastMergeSourceCommit?.commitId,
      };
    });

    return { items, failed: false };
  }


}
