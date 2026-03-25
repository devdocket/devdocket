import * as vscode from 'vscode';
import { logger } from './logger';

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

export class AdoWorkItemProvider implements WorkCenterProvider {
  readonly id = 'ado-work-items';
  readonly label = 'Azure DevOps Work Items';

  private readonly _onDidDiscoverItems = new vscode.EventEmitter<DiscoveredItem[]>();
  readonly onDidDiscoverItems = this._onDidDiscoverItems.event;

  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private _isRefreshing = false;

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
        logger.error('Work item refresh failed:', err);
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
      logger.info('Fetching assigned ADO work items...');
      const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], {
        createIfNone: true,
      }).catch(() => null);

      if (!session) {
        return;
      }

      await this.fetchAndPublishWorkItems(session.accessToken, true);
    } catch (err) {
      logger.error('Failed to fetch work items:', err);
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
    } finally {
      this._isRefreshing = false;
    }
  }

  private async fetchAndPublishWorkItems(accessToken: string, isUserTriggered: boolean): Promise<void> {
    const projectList = this.projects.length > 0 ? this.projects : [''];
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
        vscode.window.showWarningMessage(`WorkCenter ADO: ${message}`);
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

    const wiqlResponse = await fetch(wiqlUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: wiqlQuery }),
    });

    if (!wiqlResponse.ok) {
      logger.warn(`Failed to fetch work items for project: ${project || this.org}`);
      logger.error(`WIQL query failed for project "${project}": ${wiqlResponse.status}`);
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

      const detailResponse = await fetch(detailUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

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
      };
    });

    return { items, failed: batchFailed };
  }

  dispose(): void {
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }
}
