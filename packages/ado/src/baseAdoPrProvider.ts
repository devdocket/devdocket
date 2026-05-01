import * as vscode from 'vscode';
import {
  BaseProvider,
  DiscoveredItem,
  isValidUrlSegment,
  combineSignals,
  runWorkerPool,
  safeDecodeComponent,
  type ResolvedItem,
} from '@devdocket/shared';
import { logger } from './logger';
import { OrgConfig } from './configParser';
import { getAdoHeaders, retryAdoWithAuth, throwAdoApiError, ADO_AUTH_SCOPE } from './adoAuth';

export interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status?: string;
  isDraft?: boolean;
  reviewers?: Array<{
    id?: string;
    vote?: number;
  }>;
  repository: {
    name: string;
    project: { name: string };
    webUrl?: string;
  };
  lastMergeSourceCommit?: {
    commitId: string;
  };
}

interface ConnectionData {
  authenticatedUser: { id: string };
}

type SearchCriteriaParam = 'reviewerId' | 'creatorId';

type ParsedPrExternalId = {
  id: string;
  org: string;
  project: string;
  repo: string;
  prId: number;
};

export abstract class BaseAdoPrProvider extends BaseProvider {
  abstract readonly id: string;
  abstract readonly label: string;

  protected abstract readonly searchCriteriaParam: SearchCriteriaParam;
  protected abstract readonly itemReason: string;
  protected abstract readonly logLabel: string;

  private readonly cachedUserIds = new Map<string, string>();
  private cachedSessionAccountId: string | undefined;

  private static readonly ADO_PR_PATTERN = /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)\b/i;

  constructor(private readonly orgConfigs: OrgConfig[]) {
    super(new vscode.EventEmitter<DiscoveredItem[]>());
  }

  async refresh(token?: vscode.CancellationToken): Promise<void> {
    if (this._isRefreshing) {
      return;
    }

    this._isRefreshing = true;
    const abortController = new AbortController();
    const cancelListener = token?.onCancellationRequested?.(() => abortController.abort());
    try {
      logger.info(`Fetching ADO ${this.logLabel}...`);
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
        logger.debug(`ADO ${this.logLabel} fetch aborted due to cancellation`);
      } else {
        logger.error(`Failed to fetch ${this.logLabel}:`, err);
        this._onDidDiscoverItems.fire([]);
        throw err;
      }
    } finally {
      cancelListener?.dispose();
      this._isRefreshing = false;
    }
  }

  protected async doBackgroundRefresh(): Promise<void> {
    try {
      logger.info(`Fetching ADO ${this.logLabel}...`);
      const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], {
        createIfNone: false,
      }).catch(() => null);

      if (!session) {
        this._onDidDiscoverItems.fire([]);
        return;
      }

      await this.fetchAndPublishPrs(session.accessToken, false, session.account.id);
    } catch (err) {
      logger.error(`Failed to fetch ${this.logLabel}:`, err);
      this._onDidDiscoverItems.fire([]);
      throw err;
    }
  }

  protected async fetchAndPublishPrs(
    accessToken: string,
    isUserTriggered: boolean,
    sessionAccountId: string,
    signal?: AbortSignal,
  ): Promise<void> {
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
            `Failed to fetch ${this.logLabel} from ${target}:`,
            (result as PromiseRejectedResult).reason,
          );
        }
      });

      const abortedResult = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected' && result.reason instanceof Error && result.reason.name === 'AbortError',
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

    await this.postProcessItems(allItems, accessToken, signal);

    this._onDidDiscoverItems.fire(allItems);
    logger.info(`Discovered ${allItems.length} ADO ${this.logLabel}`);

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
      const message = `${this.logLabel} errors: ${messages.join('; ')}`;
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`DevDocket ADO: ${message}`);
      }
      logger.warn(message);
    }
  }

  protected mapPrToItem(pr: AdoPullRequest, org: string): DiscoveredItem {
    const resurfaceVersion = this.getResurfaceVersion(pr);
    return {
      ...this.createBaseItem(pr, org),
      reason: this.itemReason,
      ...(pr.status ? { state: pr.status } : {}),
      ...(resurfaceVersion ? { resurfaceVersion } : {}),
    };
  }

  protected async postProcessItems(_items: DiscoveredItem[], _token: string, _signal?: AbortSignal): Promise<void> {}

  protected parsePrExternalId(externalId: string): ParsedPrExternalId | undefined {
    const parts = externalId.split('/');
    if (parts.length !== 4) {
      return undefined;
    }

    const [org, project, repo, prIdSegment] = parts;
    if (!/^\d+$/.test(prIdSegment)) {
      return undefined;
    }

    return {
      id: externalId,
      org,
      project,
      repo,
      prId: Number(prIdSegment),
    };
  }

  async getClosedItems(externalIds: string[], signal?: AbortSignal): Promise<string[]> {
    if (externalIds.length === 0) {
      return [];
    }

    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], {
        createIfNone: false,
        silent: true,
      });
    } catch {
      logger.debug('No ADO auth session for getClosedItems');
    }
    if (!session) {
      return [];
    }
    const token = session.accessToken;

    const parsed = externalIds
      .map(externalId => this.parsePrExternalId(externalId))
      .filter((item): item is ParsedPrExternalId => item !== undefined);

    if (parsed.length === 0) {
      return [];
    }

    const closedSet = new Set<string>();

    await runWorkerPool(parsed, async item => {
      if (signal?.aborted) {
        return;
      }
      try {
        if (!isValidUrlSegment(item.org) || !isValidUrlSegment(item.project) || !isValidUrlSegment(item.repo)) {
          return;
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
        if (signal?.aborted) {
          return;
        }
        logger.debug(`Failed to check PR ${item.id}: ${String(err)}`);
      }
    }, 5);

    return parsed.filter(item => closedSet.has(item.id)).map(item => item.id);
  }

  async resolveUrl(url: string, signal?: AbortSignal): Promise<ResolvedItem | undefined> {
    const match = url.trim().match(BaseAdoPrProvider.ADO_PR_PATTERN);
    if (!match) {
      return undefined;
    }
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
      if (retryResponse) {
        response = retryResponse;
      }
    }

    if (!response.ok) {
      throwAdoApiError(response, `ADO PR ${org}/${project}/${repo}#${id}`);
    }

    const data = await response.json() as {
      title: string;
      description: string | null;
      repository: { name: string; project: { name: string } };
    };
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

  private createBaseItem(pr: AdoPullRequest, org: string): DiscoveredItem {
    const projectName = pr.repository.project.name;
    const repoName = pr.repository.name;
    const repoUrl = pr.repository.webUrl
      ?? `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repoName)}`;

    return {
      externalId: `${org}/${projectName}/${repoName}/${pr.pullRequestId}`,
      title: `PR ${pr.pullRequestId}: ${pr.title}`,
      description: pr.description ?? undefined,
      url: `${repoUrl}/pullrequest/${pr.pullRequestId}`,
      group: `${projectName}/${repoName}`,
    };
  }

  private getResurfaceVersion(pr: AdoPullRequest): string | undefined {
    const resurfaceOnNewVersion = vscode.workspace.getConfiguration('devDocketAdo').get<boolean>('resurfaceOnNewVersion', true);
    return resurfaceOnNewVersion ? pr.lastMergeSourceCommit?.commitId : undefined;
  }

  private async getUserId(token: string, org: string, sessionAccountId: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.cachedSessionAccountId !== sessionAccountId) {
      this.cachedUserIds.clear();
      this.cachedSessionAccountId = sessionAccountId;
    }

    const cached = this.cachedUserIds.get(org);
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
      if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) {
        throw err;
      }
      logger.error(`Network error fetching connection data for org ${org}:`, err);
      this.cachedUserIds.delete(org);
      return undefined;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.error(`Failed to fetch connection data for org ${org}: ${response.status} ${body}`);
      this.cachedUserIds.delete(org);
      return undefined;
    }

    let data: ConnectionData;
    try {
      data = (await response.json()) as ConnectionData;
    } catch (err) {
      logger.error(`Failed to parse connection data response for org ${org}:`, err);
      this.cachedUserIds.delete(org);
      return undefined;
    }

    if (!data?.authenticatedUser?.id) {
      this.cachedUserIds.delete(org);
      return undefined;
    }

    this.cachedUserIds.set(org, data.authenticatedUser.id);
    logger.debug(`Resolved user ID for org ${org}: ${data.authenticatedUser.id}`);
    return data.authenticatedUser.id;
  }

  private async fetchPrsForProject(
    token: string,
    org: string,
    project: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<{ items: DiscoveredItem[]; failed: boolean }> {
    logger.debug(`Fetching PRs for project: ${project || org}`);
    const projectPath = project ? `/${encodeURIComponent(project)}` : '';
    const url = `https://dev.azure.com/${encodeURIComponent(org)}${projectPath}/_apis/git/pullrequests?searchCriteria.${this.searchCriteriaParam}=${encodeURIComponent(userId)}&searchCriteria.status=active&api-version=7.1`;

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

    return {
      items: prData.value.map(pr => this.mapPrToItem(pr, org)),
      failed: false,
    };
  }
}
