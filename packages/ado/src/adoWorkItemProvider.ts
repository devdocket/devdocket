import * as vscode from 'vscode';
import { BaseProvider, ProviderItem, type GitWorkInfo, type ProviderBadge, type ProviderRefreshOptions, type ResolveUrlOptions, isValidUrlSegment, combineSignals, safeDecodeComponent, type ResolvedItem } from '@devdocket/shared';
import { logger } from './logger';
import { OrgConfig, resolveProjectList } from './configParser';
import { ADO_AUTH_SCOPE, getAdoHeaders, getAdoSession, retryAdoWithAuth, throwAdoApiError } from './adoAuth';

// Azure DevOps WIQL query response
interface WiqlResponse {
  workItems: { id: number; url: string }[];
}

// Azure DevOps work item detail
interface AdoWorkItem {
  id: number;
  fields: {
    'System.Title': string;
    'System.Description'?: string;
    'System.TeamProject': string;
    'System.WorkItemType': string;
    'System.State': string;
    'System.CreatedBy'?: {
      displayName?: string;
      uniqueName?: string;
    };
  };
  _links: {
    html: { href: string };
  };
  relations?: Array<{
    rel?: string;
    url?: string;
    attributes?: { name?: string };
  }>;
}

interface AdoGitRepository {
  name: string;
  remoteUrl?: string;
  webUrl?: string;
}

// Azure DevOps work item type state
interface WorkItemTypeState {
  name: string;
  category: string;
}

// Terminal state categories (Completed, Removed, Resolved) that indicate non-active work
const TERMINAL_CATEGORIES: ReadonlySet<string> = new Set(['Completed', 'Removed', 'Resolved']);

/**
 * DevDocket provider that discovers Azure DevOps work items assigned to the
 * current user.
 *
 * Uses the ADO REST API with WIQL queries and Microsoft authentication.
 * When projects are specified, only those projects are queried; otherwise
 * the entire organisation is searched.
 *
 * Filtering strategy (two-layer):
 * 1. WIQL query excludes common terminal states (Closed, Removed) for performance
 * 2. State category API filters remaining non-active items for correctness across all process templates
 */
export class AdoWorkItemProvider extends BaseProvider {
  readonly id = 'ado-work-items';
  readonly label = 'Azure DevOps Work Items';

  private _terminalStatesCache = new Map<string, Set<string>>();
  private _repoCache = new Map<string, AdoGitRepository>();

  /**
   * @param orgConfigs - One or more organization configurations to query.
   */
  constructor(
    private readonly orgConfigs: OrgConfig[],
  ) {
    super(new vscode.EventEmitter<ProviderItem[]>());
  }

  /**
   * Performs a user-triggered refresh of assigned ADO work items.
   * Prompts for authentication if no session exists.
   */
  async refresh(token?: vscode.CancellationToken, options?: ProviderRefreshOptions): Promise<void> {
    if (this._isRefreshing) {
      return;
    }

    this._isRefreshing = true;
    const abortController = new AbortController();
    const cancelListener = token?.onCancellationRequested?.(() => abortController.abort());
    const interactive = options?.interactive ?? true;
    try {
      logger.info('Fetching assigned ADO work items...');
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

      await this.fetchAndPublishWorkItems(session.accessToken, interactive, abortController.signal);
      this.markRefreshSuccess();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        logger.debug('ADO work items fetch aborted due to cancellation');
      } else {
        this._onDidDiscoverItems.fire([]);
        logger.error('Failed to fetch work items:', err);
      }
    } finally {
      cancelListener?.dispose();
      this._isRefreshing = false;
    }
  }

  protected async doBackgroundRefresh(): Promise<void> {
    try {
      logger.info('Fetching assigned ADO work items...');
      const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], {
        createIfNone: false,
      }).catch(() => null);

      if (!session) {
        this._onDidDiscoverItems.fire([]);
        return;
      }

      await this.fetchAndPublishWorkItems(session.accessToken, false);
    } catch (err) {
      this._onDidDiscoverItems.fire([]);
      logger.error('Failed to fetch work items:', err);
    }
  }

  private async fetchAndPublishWorkItems(accessToken: string, isUserTriggered: boolean, signal?: AbortSignal): Promise<void> {
    this._repoCache.clear();
    const allItems: ProviderItem[] = [];
    const failures: string[] = [];

    for (const orgConfig of this.orgConfigs) {
      if (!isValidUrlSegment(orgConfig.org)) {
        logger.warn('Skipping fetch: invalid ADO organization name', orgConfig.org);
        continue;
      }

      const projectList = resolveProjectList(orgConfig, 'fetch');
      if (projectList === null) { continue; }
      const results = await Promise.allSettled(
        projectList.map(project => this.fetchWorkItemsForProject(accessToken, orgConfig.org, project, signal)),
      );

      results.forEach((result, index) => {
        const project = projectList[index];
        const failureTarget = project ? `${orgConfig.org}/${project}` : orgConfig.org;

        if (result.status === 'fulfilled') {
          const { items, failed } = result.value;
          allItems.push(...items);
          if (failed) {
            failures.push(failureTarget);
          }
        } else {
          failures.push(failureTarget);
          const reason = (result as PromiseRejectedResult).reason;
          logger.warn(
            `Failed to fetch work items from ${failureTarget}: ` +
            (reason instanceof Error ? reason.message : String(reason)),
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
    logger.info(`Discovered ${allItems.length} ADO work items`);

    if (failures.length > 0) {
      const message = failures.length === 1
        ? `Failed to fetch work items from ${failures[0]}`
        : `Failed to fetch work items from ${failures.length} sources`;
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`DevDocket Azure DevOps: ${message}`);
      }
      logger.warn(message);
    }
  }

  private async fetchWorkItemsForProject(
    token: string,
    org: string,
    project: string,
    signal?: AbortSignal,
  ): Promise<{ items: ProviderItem[]; failed: boolean }> {
    logger.debug(`Fetching work items for project: ${project || org}`);
    const projectPath = project ? `/${encodeURIComponent(project)}` : '';
    const wiqlUrl = `https://dev.azure.com/${encodeURIComponent(org)}${projectPath}/_apis/wit/wiql?api-version=7.1`;

    const wiqlQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed' AND [System.State] <> 'Removed'`;

    let wiqlResponse: Response;
    try {
      wiqlResponse = await fetch(wiqlUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: wiqlQuery }),
        signal: combineSignals(signal, 30_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) { throw err; }
      logger.error(`Network error querying work items for project "${project || org}":`, err);
      return { items: [], failed: true };
    }

    if (!wiqlResponse.ok) {
      logger.warn(`Failed to fetch work items for project: ${project || org}`);
      logger.error(`WIQL query failed for project "${project || org}": ${wiqlResponse.status}`);
      return { items: [], failed: true };
    }

    let wiqlData: WiqlResponse;
    try {
      wiqlData = (await wiqlResponse.json()) as WiqlResponse;
    } catch (err) {
      logger.error(`Failed to parse WIQL response for ${project || org}:`, err);
      return { items: [], failed: true };
    }
    logger.debug(`WIQL returned ${wiqlData.workItems.length} work item IDs`);
    if (wiqlData.workItems.length === 0) {
      return { items: [], failed: false };
    }

    // Fetch work item details in batches (max 200 per request)
    const ids = wiqlData.workItems.map(wi => wi.id);
    const batchSize = 200;
    const allWorkItems: AdoWorkItem[] = [];
    let batchFailed = false;

    for (let i = 0; i < ids.length; i += batchSize) {
      const batchIds = ids.slice(i, i + batchSize);
      const detailUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workitems?ids=${batchIds.join(',')}&fields=System.Title,System.Description,System.TeamProject,System.WorkItemType,System.State&$expand=links&api-version=7.1`;

      let detailResponse: Response;
      try {
        detailResponse = await fetch(detailUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: combineSignals(signal, 30_000),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) { throw err; }
        logger.error(
          `Network error fetching work item details for ${project || org} (batch at index ${i}, ids ${batchIds[0]}-${batchIds[batchIds.length - 1]}):`,
          err,
        );
        batchFailed = true;
        continue;
      }

      if (!detailResponse.ok) {
        logger.error(`Failed to fetch work item details for ${project || org}: ${detailResponse.status}`);
        batchFailed = true;
        continue;
      }

      let detailData: { value: AdoWorkItem[] };
      try {
        detailData = (await detailResponse.json()) as { value: AdoWorkItem[] };
      } catch (err) {
        logger.error(`Failed to parse work item detail response for ${project || org}:`, err);
        batchFailed = true;
        continue;
      }
      logger.debug(`Fetched ${detailData.value.length} work item details in batch`);
      allWorkItems.push(...detailData.value);
    }

    // Filter out items in terminal state categories
    const activeWorkItems = await this.filterActiveItems(token, org, allWorkItems, signal);

    const items: ProviderItem[] = [];
    for (const wi of activeWorkItems) {
      const projectName = wi.fields['System.TeamProject'];
      const gitWork = await this.resolveWorkItemGitWork(token, org, projectName, wi, signal);
      items.push(this.createProviderItem(wi, org, gitWork, 'assigned'));
    }

    return { items, failed: batchFailed };
  }


  private async resolveWorkItemGitWork(
    token: string,
    org: string,
    project: string,
    workItem: AdoWorkItem,
    signal?: AbortSignal,
  ): Promise<GitWorkInfo | undefined> {
    const repoId = this.extractAssociatedRepoId(workItem);
    if (!repoId) {
      return undefined;
    }

    const repo = await this.fetchGitRepository(token, org, project, repoId, signal);
    if (!repo) {
      return undefined;
    }

    const cloneUrl = repo.remoteUrl
      ?? repo.webUrl
      ?? `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo.name)}`;
    return {
      kind: 'issue',
      cloneUrl,
      ref: `issue${workItem.id}`,
      repoLabel: `${org}/${project}/${repo.name}`,
    };
  }

  private extractAssociatedRepoId(workItem: AdoWorkItem): string | undefined {
    for (const relation of workItem.relations ?? []) {
      if (relation.rel !== 'ArtifactLink') {
        continue;
      }
      const relationName = relation.attributes?.name;
      if (relationName !== 'Branch' && relationName !== 'Pull Request') {
        continue;
      }
      if (!relation.url) {
        continue;
      }
      const decodedUrl = safeDecodeComponent(relation.url);
      const match = decodedUrl.match(/^vstfs:\/\/\/Git\/(?:Ref|PullRequestId)\/([^/]+)\/([^/]+)/i);
      const repoId = match?.[2];
      if (repoId) {
        return repoId;
      }
    }
    return undefined;
  }

  private async fetchGitRepository(
    token: string,
    org: string,
    project: string,
    repoId: string,
    signal?: AbortSignal,
  ): Promise<AdoGitRepository | undefined> {
    const cacheKey = `${org}/${project}/${repoId}`;
    const cached = this._repoCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}?api-version=7.1`;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: combineSignals(signal, 30_000),
      });
      if (!response.ok) {
        logger.debug(`Failed to fetch ADO repository ${cacheKey}: ${response.status}`);
        return undefined;
      }
      const repo = await response.json() as AdoGitRepository;
      if (!repo?.name) {
        return undefined;
      }
      this._repoCache.set(cacheKey, repo);
      return repo;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) { throw err; }
      logger.debug(`Failed to fetch ADO repository ${cacheKey}: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Fetches terminal states for a given work item type by querying the ADO Work Item Type States API.
   * States with category 'Completed', 'Removed', or 'Resolved' are considered terminal.
   * Results are cached per org/project/workItemType triple.
   *
   * @param token - Access token for ADO API
   * @param org - Organization name
   * @param project - Project name (empty string for org-level)
   * @param workItemType - Work item type name (e.g., 'Task', 'Bug', 'User Story')
   * @returns Set of terminal state names, or empty set on failure (fail open)
   */
  private async fetchTerminalStates(
    token: string,
    org: string,
    project: string,
    workItemType: string,
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    const cacheKey = `${org}/${project}/${workItemType}`;
    
    // Check cache first
    const cached = this._terminalStatesCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Build API URL
    const projectPath = project ? `/${encodeURIComponent(project)}` : '';
    const statesUrl = `https://dev.azure.com/${encodeURIComponent(org)}${projectPath}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}/states?api-version=7.1`;

    let response: Response;
    try {
      response = await fetch(statesUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: combineSignals(signal, 30_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) { throw err; }
      logger.warn(`Failed to fetch states for ${cacheKey}: network error`, err);
      return new Set<string>(); // Fail open
    }

    if (!response.ok) {
      logger.warn(`Failed to fetch states for ${cacheKey}: ${response.status}`);
      return new Set<string>(); // Fail open
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      logger.warn(`Failed to parse states response for ${cacheKey}:`, err);
      return new Set<string>(); // Fail open
    }

    if (typeof data !== 'object' || data === null || !('value' in data) || !Array.isArray((data as { value: unknown }).value)) {
      logger.warn(`Unexpected states response shape for ${cacheKey}`);
      return new Set<string>(); // Fail open
    }

    const typedData = data as { value: WorkItemTypeState[] };

    // Collect terminal state names
    const terminalStates = new Set<string>();
    for (const state of typedData.value) {
      if (state && typeof state.name === 'string' && typeof state.category === 'string' && TERMINAL_CATEGORIES.has(state.category)) {
        terminalStates.add(state.name);
      }
    }

    // Cache and return
    this._terminalStatesCache.set(cacheKey, terminalStates);
    logger.debug(`Cached ${terminalStates.size} terminal states for ${cacheKey}`);
    return terminalStates;
  }

  /**
   * Filters work items to only include those in active (non-terminal) states.
   * Groups items by (project, workItemType), fetches terminal states for each group,
   * and excludes items whose state is terminal.
   *
   * @param token - Access token for ADO API
   * @param org - ADO organization name
   * @param workItems - All work items to filter
   * @returns Only work items in active states
   */
  private async filterActiveItems(
    token: string,
    org: string,
    workItems: AdoWorkItem[],
    signal?: AbortSignal,
  ): Promise<AdoWorkItem[]> {
    if (workItems.length === 0) {
      return [];
    }

    // Group by (project, workItemType)
    const groups = new Map<string, AdoWorkItem[]>();
    for (const item of workItems) {
      const project = item.fields['System.TeamProject'];
      const workItemType = item.fields['System.WorkItemType'];
      const key = `${project}/${workItemType}`;
      
      const group = groups.get(key);
      if (group) {
        group.push(item);
      } else {
        groups.set(key, [item]);
      }
    }

    // Fetch terminal states for each unique (project, type) pair in parallel
    const entries = [...groups.keys()].map(key => {
      const [project, workItemType] = key.split('/');
      return { key, project, workItemType };
    });

    const results = await Promise.all(
      entries.map(async ({ key, project, workItemType }) => {
        const terminalStates = await this.fetchTerminalStates(token, org, project, workItemType, signal);
        return { key, terminalStates };
      }),
    );

    const terminalStatesByGroup = new Map(
      results.map(({ key, terminalStates }) => [key, terminalStates]),
    );

    // Filter out items in terminal states
    const activeItems: AdoWorkItem[] = [];
    for (const item of workItems) {
      const project = item.fields['System.TeamProject'];
      const workItemType = item.fields['System.WorkItemType'];
      const key = `${project}/${workItemType}`;
      const terminalStates = terminalStatesByGroup.get(key) || new Set<string>();
      
      const state = item.fields['System.State'];
      if (!terminalStates.has(state)) {
        activeItems.push(item);
      }
    }

    logger.debug(`Filtered ${workItems.length} items to ${activeItems.length} active items`);
    return activeItems;
  }

  /**
   * Check which of the given external IDs correspond to closed/completed ADO work items.
   * Uses the batch work items API (up to 200 per request) and checks against
   * terminal state categories (Completed, Removed, Resolved).
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

    // Parse external IDs: "org/project/id"
    const parsed = externalIds.map(id => {
      const parts = id.split('/');
      if (parts.length !== 3) { return null; }
      const [org, project, numStr] = parts;
      if (!isValidUrlSegment(org) || !isValidUrlSegment(project)) { return null; }
      if (!/^\d+$/.test(numStr)) { return null; }
      const num = parseInt(numStr, 10);
      return { id, org, workItemId: num };
    }).filter((p): p is NonNullable<typeof p> => p !== null);

    if (parsed.length === 0) { return []; }

    // Group by org for batch API calls
    const byOrg = new Map<string, typeof parsed>();
    for (const item of parsed) {
      const group = byOrg.get(item.org);
      if (group) { group.push(item); } else { byOrg.set(item.org, [item]); }
    }

    const closedSet = new Set<string>();

    for (const [org, items] of byOrg) {
      if (signal?.aborted) { break; }
      if (!isValidUrlSegment(org)) { continue; }

      const ids = items.map(i => i.workItemId);
      const batchSize = 200;

      for (let i = 0; i < ids.length; i += batchSize) {
        if (signal?.aborted) { break; }
        const batchIds = ids.slice(i, i + batchSize);
        const batchItems = items.slice(i, i + batchSize);
        const detailUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workitems?ids=${batchIds.join(',')}&fields=System.State,System.WorkItemType,System.TeamProject&api-version=7.1`;

        try {
          const response = await fetch(detailUrl, {
            headers: { Authorization: `Bearer ${token}` },
            signal,
          });

          if (!response.ok) {
            logger.debug(`Failed to fetch work item details for org ${org}: ${response.status}`);
            continue;
          }

          const data = (await response.json()) as { value: AdoWorkItem[] };
          const workItemMap = new Map<number, AdoWorkItem>();
          for (const wi of data.value) {
            workItemMap.set(wi.id, wi);
          }

          // Group by (project, workItemType) and fetch terminal states per group
          const groupedItems = new Map<string, {
            project: string;
            workItemType: string;
            items: Array<{ id: string; state: string }>;
          }>();

          for (const item of batchItems) {
            const wi = workItemMap.get(item.workItemId);
            if (!wi) { continue; }
            const state = wi.fields['System.State'];
            const project = wi.fields['System.TeamProject'];
            const workItemType = wi.fields['System.WorkItemType'];
            const groupKey = `${project}\0${workItemType}`;
            const group = groupedItems.get(groupKey);
            if (group) {
              group.items.push({ id: item.id, state });
            } else {
              groupedItems.set(groupKey, { project, workItemType, items: [{ id: item.id, state }] });
            }
          }

          const terminalStatesByGroup = new Map<string, Set<string>>();
          await Promise.all(
            Array.from(groupedItems.entries()).map(async ([groupKey, group]) => {
              const terminalStates = await this.fetchTerminalStates(token, org, group.project, group.workItemType, signal);
              terminalStatesByGroup.set(groupKey, terminalStates);
            }),
          );

          for (const [groupKey, group] of groupedItems) {
            const terminalStates = terminalStatesByGroup.get(groupKey);
            if (!terminalStates) { continue; }
            for (const item of group.items) {
              if (terminalStates.has(item.state)) {
                closedSet.add(item.id);
              }
            }
          }
        } catch (err) {
          if (signal?.aborted) { break; }
          logger.debug(`Failed to check work items for org ${org}: ${String(err)}`);
        }
      }
    }

    // Return in input order for deterministic results
    return parsed.filter(p => closedSet.has(p.id)).map(p => p.id);
  }

  private static readonly ADO_WORKITEM_PATTERN = /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_workitems\/edit\/(\d+)\b/i;

  async resolveUrl(url: string, signal?: AbortSignal, options?: ResolveUrlOptions): Promise<ResolvedItem | undefined> {
    const match = url.trim().match(AdoWorkItemProvider.ADO_WORKITEM_PATTERN);
    if (!match) { return undefined; }
    const [, rawOrg, rawProject, idStr] = match;
    const org = safeDecodeComponent(rawOrg);
    const project = safeDecodeComponent(rawProject);
    const id = parseInt(idStr, 10);

    const apiUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems/${id}?api-version=7.1`;
    const headers = await getAdoHeaders();
    const wasAuthenticated = 'Authorization' in headers;

    let response = await fetch(apiUrl, { headers, signal });

    if (response.status === 404 && !wasAuthenticated && !signal?.aborted && options?.interactive !== false) {
      const retryResponse = await retryAdoWithAuth(apiUrl, signal, { interactive: true });
      if (retryResponse) { response = retryResponse; }
    }

    if (!response.ok) {
      throwAdoApiError(response, `ADO work item ${org}/${project}#${id}`);
    }

    const data = await response.json() as AdoWorkItem;
    const teamProject = data.fields['System.TeamProject'];
    const htmlUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(teamProject)}/_workitems/edit/${id}`;
    const token = this.extractBearerToken(headers)
      ?? (await getAdoSession({ interactive: false, signal }))?.accessToken;
    const gitWork = token
      ? await this.resolveWorkItemGitWork(token, org, teamProject, data, signal)
      : undefined;
    const item = this.createProviderItem({
      ...data,
      id,
      _links: {
        html: { href: data._links?.html?.href ?? htmlUrl },
      },
    }, org, gitWork);
    return {
      ...item,
      notes: item.description ?? '',
      providerId: this.id,
      url: htmlUrl,
    };
  }

  private createProviderItem(wi: AdoWorkItem, org: string, gitWork?: GitWorkInfo, reason?: string): ProviderItem {
    const projectName = wi.fields['System.TeamProject'];
    const wiType = wi.fields['System.WorkItemType'];
    const state = wi.fields['System.State'];
    const badges: ProviderBadge[] = state ? [{ label: state, variant: 'info', show: 'editor' }] : [];
    const description = this.stripHtml(wi.fields['System.Description'] ?? '');

    return {
      externalId: `${org}/${projectName}/${wi.id}`,
      title: `${wiType} ${wi.id}: ${wi.fields['System.Title']}`,
      ...(description ? { description } : {}),
      url: wi._links.html.href,
      ...(wi.fields['System.CreatedBy']?.displayName ? {
        author: {
          displayName: wi.fields['System.CreatedBy'].displayName,
          handle: wi.fields['System.CreatedBy'].uniqueName,
        },
      } : {}),
      group: `${org}/${projectName}`,
      ...(reason ? { reason } : {}),
      ...(state ? { state } : {}),
      itemType: 'issue',
      ...(gitWork ? { capabilities: { gitWork } } : {}),
      ...(badges.length > 0 ? { badges } : {}),
    };
  }

  private extractBearerToken(headers: Record<string, string>): string | undefined {
    const authorization = headers['Authorization'];
    if (!authorization) {
      return undefined;
    }
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match?.[1];
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
