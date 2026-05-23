import * as vscode from 'vscode';
import {
  BaseProvider,
  ProviderItem,
  type ProviderBadge,
  type ProviderRefreshOptions,
  type ResolveUrlOptions,
  isValidUrlSegment,
  combineSignals,
  createAbortError,
  runWorkerPool,
  safeDecodeComponent,
  type ResolvedItem,
  type GitWorkInfo,
} from '@devdocket/shared';
import { logger } from './logger';
import { OrgConfig, resolveProjectList } from './configParser';
import { ADO_AUTH_SCOPE, getAdoHeaders, getAdoSession, retryAdoWithAuth, throwAdoApiError } from './adoAuth';

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
  createdBy?: {
    displayName?: string;
    uniqueName?: string;
  };
  repository: {
    name: string;
    project: { name: string };
    webUrl?: string;
    remoteUrl?: string;
    sshUrl?: string;
  };
  sourceRefName?: string;
  targetRefName?: string;
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
  protected readonly additionalSearchCriteriaFailureLabel = 'additional identity lookup';

  private readonly cachedUserIds = new Map<string, string>();
  private cachedSessionAccountId: string | undefined;

  private static readonly ADO_PR_PATTERN = /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)\b/i;

  constructor(private readonly orgConfigs: OrgConfig[]) {
    super(new vscode.EventEmitter<ProviderItem[]>());
  }

  async refresh(token?: vscode.CancellationToken, options?: ProviderRefreshOptions): Promise<void> {
    if (this._isRefreshing) {
      return;
    }

    this._isRefreshing = true;
    const abortController = new AbortController();
    const cancelListener = token?.onCancellationRequested?.(() => abortController.abort());
    const interactive = options?.interactive ?? true;
    try {
      logger.info(`Fetching ADO ${this.logLabel}...`);
      if (token?.isCancellationRequested) {
        return;
      }

      let session: vscode.AuthenticationSession | undefined;
      try {
        session = await getAdoSession({
          interactive,
          signal: abortController.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw err;
        }
        session = undefined;
      }

      if (token?.isCancellationRequested) {
        return;
      }
      if (!session) {
        this._onDidDiscoverItems.fire([]);
        return;
      }

      await this.fetchAndPublishPrs(session.accessToken, interactive, session.account.id, abortController.signal);
      this.markRefreshSuccess();
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
    const allItems: ProviderItem[] = [];
    const identityFailures: string[] = [];
    const fetchFailures: string[] = [];
    const additionalIdentityLookupFailures: string[] = [];

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

      const projectList = resolveProjectList(orgConfig, 'PR fetch');
      if (projectList === null) { continue; }

      const directFetch = await this.fetchPrsForProjects(accessToken, orgConfig.org, projectList, userId, signal);
      allItems.push(...directFetch.items);
      fetchFailures.push(...directFetch.failedTargets);

      let additionalSearchCriteriaValues: string[] = [];
      try {
        additionalSearchCriteriaValues = await this.getAdditionalSearchCriteriaValues(
          accessToken,
          orgConfig.org,
          userId,
          sessionAccountId,
          signal,
        );
      } catch (err) {
        if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError') && signal?.aborted) {
          throw createAbortError();
        }
        additionalIdentityLookupFailures.push(orgConfig.org);
        logger.warn(`Failed to determine additional ADO ${this.logLabel} identities for org ${orgConfig.org}`);
        logger.debug(`Additional ADO ${this.logLabel} identity lookup failed for org ${orgConfig.org}: ${String(err)}`);
      }

      const uniqueAdditionalValues = [...new Set(additionalSearchCriteriaValues)].filter(value => value !== userId);
      const additionalFetches: Array<{ items: ProviderItem[]; failedTargets: string[] }> = [];
      await runWorkerPool(uniqueAdditionalValues, async searchCriteriaValue => {
        const additionalFetch = await this.fetchPrsForProjects(
          accessToken,
          orgConfig.org,
          projectList,
          searchCriteriaValue,
          signal,
        );
        additionalFetches.push(additionalFetch);
      }, 5);
      for (const additionalFetch of additionalFetches) {
        allItems.push(...additionalFetch.items);
        fetchFailures.push(...additionalFetch.failedTargets);
      }
    }

    const dedupedItems = this.dedupeItems(allItems);
    await this.postProcessItems(dedupedItems, accessToken, signal);

    this._onDidDiscoverItems.fire(dedupedItems);
    logger.info(`Discovered ${dedupedItems.length} ADO ${this.logLabel}`);

    const messages: string[] = [];
    if (identityFailures.length > 0) {
      messages.push(`user identity failed for ${identityFailures.join(', ')}`);
    }
    const uniqueFetchFailures = [...new Set(fetchFailures)];
    if (uniqueFetchFailures.length > 0) {
      messages.push(
        uniqueFetchFailures.length === 1
          ? `failed to fetch from ${uniqueFetchFailures[0]}`
          : `failed to fetch from ${uniqueFetchFailures.length} sources`,
      );
    }
    if (additionalIdentityLookupFailures.length > 0) {
      messages.push(
        additionalIdentityLookupFailures.length === 1
          ? `${this.additionalSearchCriteriaFailureLabel} failed for ${additionalIdentityLookupFailures[0]}`
          : `${this.additionalSearchCriteriaFailureLabel} failed for ${additionalIdentityLookupFailures.length} orgs`,
      );
    }
    if (messages.length > 0) {
      const message = `${this.logLabel} errors: ${messages.join('; ')}`;
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`DevDocket Azure DevOps: ${message}`);
      }
      logger.warn(message);
    }
  }

  protected mapPrToItem(pr: AdoPullRequest, org: string): ProviderItem {
    const resurfaceVersion = this.getResurfaceVersion(pr);
    const stateBadge = buildAdoPrStateBadge(pr.status);
    return {
      ...this.createBaseItem(pr, org),
      reason: this.itemReason,
      ...(pr.status ? { state: pr.status } : {}),
      ...(resurfaceVersion ? { resurfaceVersion } : {}),
      ...(stateBadge ? { badges: [stateBadge] } : {}),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async postProcessItems(_items: ProviderItem[], _token: string, _signal?: AbortSignal): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async getAdditionalSearchCriteriaValues(_token: string, _org: string, _userId: string, _sessionAccountId: string, _signal?: AbortSignal): Promise<string[]> {
    return [];
  }

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
        throw createAbortError();
      }
      try {
        if (!isValidUrlSegment(item.org) || !isValidUrlSegment(item.project) || !isValidUrlSegment(item.repo)) {
          return;
        }
        const url = `https://dev.azure.com/${encodeURIComponent(item.org)}/${encodeURIComponent(item.project)}/_apis/git/repositories/${encodeURIComponent(item.repo)}/pullrequests/${item.prId}?api-version=7.1`;
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: combineSignals(signal, 30_000),
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
        if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) {
          throw err;
        }
        logger.debug(`Failed to check PR ${item.id}: ${String(err)}`);
      }
    }, 5);

    return parsed.filter(item => closedSet.has(item.id)).map(item => item.id);
  }

  async resolveUrl(url: string, signal?: AbortSignal, options?: ResolveUrlOptions): Promise<ResolvedItem | undefined> {
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
      const retryResponse = await retryAdoWithAuth(apiUrl, signal, { interactive: true });
      if (retryResponse) {
        response = retryResponse;
      }
    }

    if (!response.ok) {
      throwAdoApiError(response, `ADO PR ${org}/${project}/${repo}#${id}`);
    }

    const data = await response.json() as AdoPullRequest & {
      title: string;
      description: string | null;
      repository: {
        name: string;
        project: { name: string };
        webUrl?: string;
        remoteUrl?: string;
      };
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
      itemType: 'pr',
      capabilities: {
        gitWork: this.createPrGitWork({
          ...data,
          pullRequestId: id,
          repository: {
            ...data.repository,
            name: repoName,
            project: { name: projectName },
          },
        }, org),
      },
    };
  }

  private createBaseItem(pr: AdoPullRequest, org: string): ProviderItem {
    const projectName = pr.repository.project.name;
    const repoName = pr.repository.name;
    const repoUrl = pr.repository.webUrl
      ?? `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repoName)}`;

    return {
      externalId: `${org}/${projectName}/${repoName}/${pr.pullRequestId}`,
      title: `PR ${pr.pullRequestId}: ${pr.title}`,
      description: pr.description ?? undefined,
      url: `${repoUrl}/pullrequest/${pr.pullRequestId}`,
      ...(pr.createdBy?.displayName ? {
        author: {
          displayName: pr.createdBy.displayName,
          handle: pr.createdBy.uniqueName,
        },
      } : {}),
      group: `${projectName}/${repoName}`,
      itemType: 'pr',
      capabilities: { gitWork: this.createPrGitWork(pr, org) },
    };
  }

  private createPrGitWork(pr: AdoPullRequest, org: string): () => Promise<GitWorkInfo | undefined> {
    const projectName = pr.repository.project.name;
    const repoName = pr.repository.name;
    const repoLabel = `${projectName}/${repoName}`;
    const cloneUrl = pr.repository.remoteUrl
      ?? pr.repository.webUrl
      ?? `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repoName)}`;
    const detailUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${encodeURIComponent(repoName)}/pullrequests/${pr.pullRequestId}?api-version=7.1`;

    return async () => {
      // Resolve the source ref at action time so Start Git Work checks out the current PR head.
      const headers = await getAdoHeaders();
      const wasAuthenticated = 'Authorization' in headers;
      let response = await fetch(detailUrl, {
        headers,
        signal: combineSignals(undefined, 30_000),
      });
      if (response.status === 401 || response.status === 403 || (response.status === 404 && !wasAuthenticated)) {
        const retryResponse = await retryAdoWithAuth(detailUrl, undefined, { interactive: true });
        if (retryResponse) { response = retryResponse; }
      }
      if (!response.ok) {
        logger.info(`ADO PR API returned ${response.status} while resolving git work info for ${org}/${projectName}/${repoName}/${pr.pullRequestId}`);
        return undefined;
      }

      const detail = await response.json() as Pick<AdoPullRequest, 'sourceRefName' | 'targetRefName' | 'repository'>;
      const sourceRefName = typeof detail.sourceRefName === 'string' ? detail.sourceRefName : pr.sourceRefName;
      if (!sourceRefName) {
        return undefined;
      }

      const detailCloneUrl = detail.repository?.remoteUrl ?? detail.repository?.webUrl ?? cloneUrl;
      const targetRefName = typeof detail.targetRefName === 'string' ? detail.targetRefName : pr.targetRefName;
      return {
        kind: 'pr',
        cloneUrl: detailCloneUrl,
        ref: sourceRefName.replace(/^refs\/heads\//, ''),
        ...(targetRefName ? { baseRef: targetRefName.replace(/^refs\/heads\//, '') } : {}),
        repoLabel,
      };
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

  private async fetchPrsForProjects(
    token: string,
    org: string,
    projectList: string[],
    searchCriteriaValue: string,
    signal?: AbortSignal,
  ): Promise<{ items: ProviderItem[]; failedTargets: string[] }> {
    const items: ProviderItem[] = [];
    const failedTargets: string[] = [];
    const results = await Promise.allSettled(
      projectList.map(project => this.fetchPrsForProject(token, org, project, searchCriteriaValue, signal)),
    );

    results.forEach((result, index) => {
      const project = projectList[index];
      const target = project ? `${org}/${project}` : org;

      if (result.status === 'fulfilled') {
        items.push(...result.value.items);
        if (result.value.failed) {
          failedTargets.push(target);
        }
      } else {
        failedTargets.push(target);
        const reason = result.reason;
        const isAbortError = reason instanceof Error && (reason.name === 'AbortError' || reason.name === 'TimeoutError');
        if (!isAbortError && !signal?.aborted) {
          logger.error(
            `Failed to fetch ${this.logLabel} from ${target}:`,
            reason,
          );
        }
      }
    });

    const abortedResult = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' && result.reason instanceof Error && result.reason.name === 'AbortError',
    );
    if (signal?.aborted) {
      if (abortedResult) {
        throw abortedResult.reason;
      }
      throw createAbortError();
    }

    return { items, failedTargets };
  }

  private dedupeItems(items: ProviderItem[]): ProviderItem[] {
    // Direct-reviewer fetches run first, so direct assignments win over duplicate group hits.
    const deduped = new Map<string, ProviderItem>();
    for (const item of items) {
      if (!deduped.has(item.externalId)) {
        deduped.set(item.externalId, item);
      }
    }
    return [...deduped.values()];
  }

  private async fetchPrsForProject(
    token: string,
    org: string,
    project: string,
    searchCriteriaValue: string,
    signal?: AbortSignal,
  ): Promise<{ items: ProviderItem[]; failed: boolean }> {
    logger.debug(`Fetching PRs for project: ${project || org}`);
    const projectPath = project ? `/${encodeURIComponent(project)}` : '';
    const url = `https://dev.azure.com/${encodeURIComponent(org)}${projectPath}/_apis/git/pullrequests?searchCriteria.${this.searchCriteriaParam}=${encodeURIComponent(searchCriteriaValue)}&searchCriteria.status=active&api-version=7.1`;

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

/**
 * Builds the editor-only state badge for an ADO pull request based on its
 * raw status (e.g., 'active', 'completed', 'abandoned'). Returns undefined
 * when status is missing so the caller can spread or skip it. Active PRs
 * render as info; everything else is shown as a neutral pill.
 */
export function buildAdoPrStateBadge(status?: string): ProviderBadge | undefined {
  if (!status) {
    return undefined;
  }
  const normalized = status.toLowerCase();
  const label = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
  return {
    label,
    variant: normalized === 'active' ? 'info' : 'neutral',
    show: 'editor',
  };
}

/**
 * Builds the editor-only state badge for an ADO PR's vote-based status as
 * surfaced by {@link AdoMyPrsProvider}. Maps each derived status to a
 * sensible severity so reviewers can spot Rejected / Waiting for author
 * states at a glance in the editor.
 */
export function buildAdoMyPrsStateBadge(state?: string): ProviderBadge | undefined {
  if (!state) {
    return undefined;
  }
  const variant: ProviderBadge['variant'] = (() => {
    switch (state) {
      case 'Approved': return 'success';
      case 'Rejected': return 'danger';
      case 'Waiting for author': return 'warning';
      case 'Draft': return 'neutral';
      case 'Waiting on reviews':
      case 'Review in progress':
      default: return 'info';
    }
  })();
  return { label: state, variant, show: 'editor' };
}
