import * as vscode from 'vscode';
import { BaseProvider, DiscoveredItem, isValidUrlSegment } from '@workcenter/shared';
import { logger } from './logger';



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
  };
  _links: {
    html: { href: string };
  };
}

// Azure DevOps REST API scope for authentication
const ADO_AUTH_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

export class AdoWorkItemProvider extends BaseProvider {
  readonly id = 'ado-work-items';
  readonly label = 'Azure DevOps Work Items';

  constructor(
    private readonly org: string,
    private readonly projects: string[],
  ) {
    super(new vscode.EventEmitter<DiscoveredItem[]>());
  }

  async refresh(token?: vscode.CancellationToken): Promise<void> {
    if (this._isRefreshing) {
      return;
    }

    this._isRefreshing = true;
    try {
      logger.info('Fetching assigned ADO work items...');
      if (token?.isCancellationRequested) {
        return;
      }

      const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], {
        createIfNone: true,
      }).catch(() => null);

      if (!session || token?.isCancellationRequested) {
        return;
      }

      await this.fetchAndPublishWorkItems(session.accessToken, true);
    } catch (err) {
      logger.error('Failed to fetch work items:', err);
    } finally {
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
        return;
      }

      await this.fetchAndPublishWorkItems(session.accessToken, false);
    } catch (err) {
      logger.error('Failed to fetch work items:', err);
    }
  }

  private async fetchAndPublishWorkItems(accessToken: string, isUserTriggered: boolean): Promise<void> {
    if (!isValidUrlSegment(this.org)) {
      logger.warn('Skipping fetch: invalid ADO organization name', this.org);
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
      logger.warn('All configured ADO projects are invalid — skipping fetch');
      return;
    }

    const projectList = validProjects.length > 0 ? validProjects : [''];
    const results = await Promise.allSettled(
      projectList.map(project => this.fetchWorkItemsForProject(accessToken, project)),
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
        const failureTarget = projectList[index] || this.org;
        failures.push(failureTarget);
        const reason = (result as PromiseRejectedResult).reason;
        logger.warn(
          `Failed to fetch work items from ${failureTarget}: ` +
          (reason instanceof Error ? reason.message : String(reason)),
        );
      }
    });

    this._onDidDiscoverItems.fire(allItems);
    logger.info(`Discovered ${allItems.length} ADO work items`);

    if (failures.length > 0) {
      const message = failures.length === 1
        ? `Failed to fetch work items from ${failures[0]}`
        : `Failed to fetch work items from ${failures.length} projects`;
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`WorkCenter ADO: ${message}`);
      }
      logger.warn(message);
    }
  }

  private async fetchWorkItemsForProject(
    token: string,
    project: string,
  ): Promise<{ items: DiscoveredItem[]; failed: boolean }> {
    logger.debug(`Fetching work items for project: ${project || this.org}`);
    const projectPath = project ? `/${encodeURIComponent(project)}` : '';
    const wiqlUrl = `https://dev.azure.com/${encodeURIComponent(this.org)}${projectPath}/_apis/wit/wiql?api-version=7.1`;

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
      });
    } catch (err) {
      logger.error(`Network error querying work items for project "${project || this.org}":`, err);
      return { items: [], failed: true };
    }

    if (!wiqlResponse.ok) {
      logger.warn(`Failed to fetch work items for project: ${project || this.org}`);
      logger.error(`WIQL query failed for project "${project || this.org}": ${wiqlResponse.status}`);
      return { items: [], failed: true };
    }

    let wiqlData: WiqlResponse;
    try {
      wiqlData = (await wiqlResponse.json()) as WiqlResponse;
    } catch (err) {
      logger.error(`Failed to parse WIQL response for project "${project}":`, err);
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
      const detailUrl = `https://dev.azure.com/${encodeURIComponent(this.org)}/_apis/wit/workitems?ids=${batchIds.join(',')}&fields=System.Title,System.Description,System.TeamProject,System.WorkItemType,System.State&$expand=links&api-version=7.1`;

      let detailResponse: Response;
      try {
        detailResponse = await fetch(detailUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      } catch (err) {
        logger.error(
          `Network error fetching work item details for ${project || this.org} (batch at index ${i}, ids ${batchIds[0]}-${batchIds[batchIds.length - 1]}):`,
          err,
        );
        batchFailed = true;
        continue;
      }

      if (!detailResponse.ok) {
        logger.error(`Failed to fetch work item details: ${detailResponse.status}`);
        batchFailed = true;
        continue;
      }

      let detailData: { value: AdoWorkItem[] };
      try {
        detailData = (await detailResponse.json()) as { value: AdoWorkItem[] };
      } catch (err) {
        logger.error('Failed to parse work item detail response:', err);
        batchFailed = true;
        continue;
      }
      logger.debug(`Fetched ${detailData.value.length} work item details in batch`);
      allWorkItems.push(...detailData.value);
    }

    const items: DiscoveredItem[] = allWorkItems.map((wi) => {
      const projectName = wi.fields['System.TeamProject'];
      const wiType = wi.fields['System.WorkItemType'];
      return {
        externalId: `${projectName}/${wi.id}`,
        title: `${wiType} ${wi.id}: ${wi.fields['System.Title']}`,
        description: wi.fields['System.Description']?.replace(/<[^>]*>/g, '')?.slice(0, 200),
        url: wi._links.html.href,
        group: projectName,
        reason: 'assigned',
      };
    });

    return { items, failed: batchFailed };
  }

}
