import * as vscode from 'vscode';
import { BaseProvider, DiscoveredItem, isValidUrlSegment, combineSignals, type ResolvedItem } from '@devdocket/shared';
import { logger } from './logger';
import { OrgConfig } from './configParser';
import { getAdoHeaders, retryAdoWithAuth, throwAdoApiError, safeDecodeComponent } from './adoAuth';

interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status?: string;
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
    const abortController = new AbortController();
    const cancelListener = token?.onCancellationRequested?.(() => abortController.abort());
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

      await this.fetchAndPublishPrs(session.accessToken, true, session.account.id, abortController.signal);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && abortController.signal.aborted && token?.isCancellationRequested) {
        logger.debug('ADO PR reviews fetch aborted due to cancellation');
      } else {
        this._onDidDiscoverItems.fire([]);
        logger.error('Failed to fetch PR reviews:', err);
      }
    } finally {
      cancelListener?.dispose();
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

  private async fetchAndPublishPrs(accessToken: string, isUserTriggered: boolean, sessionAccountId: string, signal?: AbortSignal): Promise<void> {
    const allItems: DiscoveredItem[] = [];
    const identityFailures: string[] = [];
    const fetchFailures: string[] = [];

    for (const orgConfig of this.orgConfigs) {
      if (!isValidUrlSegment(orgConfig.org)) {
        logger.warn('Skipping PR fetch: invalid ADO organization name', orgConfig.org);
        continue;
      }

      const userId = await this.getUserId(accessToken, orgConfig.org, sessionAccountId, signal);
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
        projectList.map(project => this.fetchPrsForProject(accessToken, orgConfig.org, project, userId, signal)),
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

      // Propagate cancellation so the refresh stops without publishing partial results
      const abortedResult = results.find(
        (r): r is PromiseRejectedResult =>
          r.status === 'rejected' && r.reason instanceof Error && r.reason.name === 'AbortError',
      );
      if (signal?.aborted || abortedResult) {
        if (abortedResult) {
          throw abortedResult.reason;
        }
        const abortError = new Error('The operation was aborted.');
        abortError.name = 'AbortError';
        throw abortError;
      }
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

  private async getUserId(token: string, org: string, sessionAccountId: string, signal?: AbortSignal): Promise<string | undefined> {
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
          signal: combineSignals(signal, 30_000),
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) { throw err; }
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
    signal?: AbortSignal,
  ): Promise<{ items: DiscoveredItem[]; failed: boolean }> {
    logger.debug(`Fetching PRs for project: ${project || org}`);
    const projectPath = project ? `/${encodeURIComponent(project)}` : '';
    const url = `https://dev.azure.com/${encodeURIComponent(org)}${projectPath}/_apis/git/pullrequests?searchCriteria.reviewerId=${encodeURIComponent(reviewerId)}&searchCriteria.status=active&api-version=7.1`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: combineSignals(signal, 30_000),
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
    const resurfaceOnNewVersion = vscode.workspace.getConfiguration('devdocketAdo').get<boolean>('resurfaceOnNewVersion', true);
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
        ...(pr.status ? { state: pr.status } : {}),
        version: resurfaceOnNewVersion ? pr.lastMergeSourceCommit?.commitId : undefined,
      };
    });

    return { items, failed: false };
  }

  /**
   * Check which of the given external IDs correspond to completed/abandoned ADO PRs.
   * Uses concurrent individual API calls with a worker pool since there is
   * no batch PR-get endpoint.
   */
  async getClosedItems(externalIds: string[], signal?: AbortSignal): Promise<string[]> {
    if (externalIds.length === 0) { return []; }

    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], {
        createIfNone: false,
        silent: true,
      });
    } catch {
      logger.debug('No ADO auth session for getClosedItems');
    }
    if (!session) { return []; }
    const token = session.accessToken;

    // Parse external IDs: "org/project/repo/prId"
    const parsed = externalIds.map(id => {
      const parts = id.split('/');
      if (parts.length !== 4) { return null; }
      const org = parts[0];
      const project = parts[1];
      const repo = parts[2];
      const prIdSegment = parts[3];
      if (!/^\d+$/.test(prIdSegment)) { return null; }
      const prId = Number(prIdSegment);
      return { id, org, project, repo, prId };
    }).filter((p): p is NonNullable<typeof p> => p !== null);

    if (parsed.length === 0) { return []; }

    const closedSet = new Set<string>();
    let nextIndex = 0;

    const runWorker = async (): Promise<void> => {
      while (nextIndex < parsed.length) {
        if (signal?.aborted) { break; }
        const currentIndex = nextIndex++;
        const item = parsed[currentIndex];
        try {
          if (!isValidUrlSegment(item.org) || !isValidUrlSegment(item.project) || !isValidUrlSegment(item.repo)) {
            continue;
          }
          const url = `https://dev.azure.com/${encodeURIComponent(item.org)}/${encodeURIComponent(item.project)}/_apis/git/repositories/${encodeURIComponent(item.repo)}/pullrequests/${item.prId}?api-version=7.1`;
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal,
          });
          if (response.ok) {
            const data = await response.json() as { status?: string };
            if (data.status === 'completed' || data.status === 'abandoned') {
              closedSet.add(item.id);
            }
          } else {
            logger.debug(`Failed to check PR ${item.id}: ${response.status}`);
          }
        } catch (err) {
          if (signal?.aborted) { break; }
          logger.debug(`Failed to check PR ${item.id}: ${String(err)}`);
        }
      }
    };

    const workerCount = Math.min(5, parsed.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    // Return in input order for deterministic results
    return parsed.filter(p => closedSet.has(p.id)).map(p => p.id);
  }

  private static readonly ADO_PR_PATTERN = /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)\b/i;

  async resolveUrl(url: string, signal?: AbortSignal): Promise<ResolvedItem | undefined> {
    const match = url.trim().match(AdoPrReviewProvider.ADO_PR_PATTERN);
    if (!match) { return undefined; }
    const [, rawOrg, rawProject, rawRepo, idStr] = match;
    const org = safeDecodeComponent(rawOrg);
    const project = safeDecodeComponent(rawProject);
    const repo = safeDecodeComponent(rawRepo);
    const id = parseInt(idStr, 10);

    const apiUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}?api-version=7.1`;
    const headers = await getAdoHeaders();
    const wasAuthenticated = 'Authorization' in headers;

    let response = await fetch(apiUrl, { headers, signal });

    if (response.status === 404 && !wasAuthenticated && !signal?.aborted) {
      const retryResponse = await retryAdoWithAuth(apiUrl, signal);
      if (retryResponse) { response = retryResponse; }
    }

    if (!response.ok) {
      throwAdoApiError(response, `ADO PR ${org}/${project}/${repo}#${id}`);
    }

    const data = await response.json() as { title: string; description: string | null; repository: { name: string; project: { name: string } } };
    const projectName = data.repository.project.name;
    const repoName = data.repository.name;
    const htmlUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repoName)}/pullrequest/${id}`;
    return {
      title: `#${id}: ${data.title}`,
      notes: data.description ?? '',
      url: htmlUrl,
      externalId: `${org}/${projectName}/${repoName}/${id}`,
      group: `${projectName}/${repoName}`,
      providerId: this.id,
    };
  }
}
