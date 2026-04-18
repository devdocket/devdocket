import * as vscode from 'vscode';
import { BaseProvider, DiscoveredItem, StatusWatcher, type StatusChange, isValidUrlSegment } from '@devdocket/shared';
import { logger } from './logger';
import { OrgConfig } from './configParser';

/** Azure DevOps REST API scope for authentication. */
const ADO_AUTH_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

/** A build from the ADO Builds REST API. */
interface AdoBuild {
  id: number;
  buildNumber: string;
  status: string;
  result: string | null;
  definition: { name: string };
  sourceBranch: string;
  _links: { web: { href: string } };
  project: { name: string };
  startTime?: string;
  finishTime?: string;
}

/** A timeline record (job/stage) from the ADO Build Timeline API. */
interface TimelineRecord {
  id: string;
  name: string;
  type: string;
  state: string;
  result: string | null;
}

/**
 * Compose a trackable status string from a build.
 * For completed builds, includes the result (e.g. `completed:failed`).
 */
function compositeStatus(build: AdoBuild): string {
  if (build.status === 'completed' && build.result) {
    return `completed:${build.result}`;
  }
  return build.status;
}

/** Strip the refs/heads/ prefix from a branch name. */
function formatBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, '');
}

/**
 * DevDocket provider that watches Azure DevOps pipeline builds for status
 * changes and fires VS Code notifications on completion or failure.
 *
 * Fetches recent builds from configured organizations/projects, tracks
 * their status across polling cycles, and detects both build-level
 * transitions and early individual job failures within in-progress builds.
 *
 * Active (non-completed) builds are emitted as {@link DiscoveredItem}s so
 * they appear in the Sources and Inbox views.
 */
export class AdoPipelineProvider extends BaseProvider {
  readonly id = 'ado-pipelines';
  readonly label = 'Azure DevOps Pipelines';

  private readonly buildWatcher = new StatusWatcher<string>();
  /** Tracks which job failures have already been notified per build. */
  private readonly notifiedJobFailures = new Map<number, Set<string>>();

  constructor(private readonly orgConfigs: OrgConfig[]) {
    super(new vscode.EventEmitter<DiscoveredItem[]>());
  }

  async refresh(token?: vscode.CancellationToken): Promise<void> {
    if (this._isRefreshing) { return; }
    this._isRefreshing = true;
    try {
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

      await this.fetchAndPublish(session.accessToken, true);
    } catch (err) {
      this._onDidDiscoverItems.fire([]);
      logger.error('Failed to fetch ADO pipeline builds:', err);
    } finally {
      this._isRefreshing = false;
    }
  }

  protected async doBackgroundRefresh(): Promise<void> {
    try {
      const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], {
        createIfNone: false,
      }).catch(() => null);

      if (!session) {
        this._onDidDiscoverItems.fire([]);
        return;
      }

      await this.fetchAndPublish(session.accessToken, false);
    } catch (err) {
      this._onDidDiscoverItems.fire([]);
      logger.error('Failed to fetch ADO pipeline builds:', err);
    }
  }

  private async fetchAndPublish(accessToken: string, isUserTriggered: boolean): Promise<void> {
    logger.info('Fetching ADO pipeline builds...');

    const allBuilds: AdoBuild[] = [];
    const fetchFailures: string[] = [];

    for (const orgConfig of this.orgConfigs) {
      if (!isValidUrlSegment(orgConfig.org)) {
        logger.warn('Skipping pipeline fetch: invalid ADO organization name', orgConfig.org);
        continue;
      }

      const validProjects: string[] = [];
      for (const project of orgConfig.projects) {
        if (project === '' || isValidUrlSegment(project)) {
          validProjects.push(project);
        } else {
          logger.warn('Skipping invalid ADO project name for pipeline fetch', project);
        }
      }

      if (orgConfig.projects.length > 0 && validProjects.length === 0) {
        logger.warn(`All configured ADO projects are invalid for org ${orgConfig.org} — skipping pipeline fetch`);
        continue;
      }

      const projectList = validProjects.length > 0 ? validProjects : [''];
      const results = await Promise.allSettled(
        projectList.map(project => this.fetchBuilds(accessToken, orgConfig.org, project)),
      );

      results.forEach((result, index) => {
        const project = projectList[index];
        const target = project ? `${orgConfig.org}/${project}` : orgConfig.org;

        if (result.status === 'fulfilled') {
          allBuilds.push(...result.value);
        } else {
          fetchFailures.push(target);
          logger.error(`Failed to fetch pipeline builds from ${target}:`, result.reason);
        }
      });
    }

    logger.info(`Fetched ${allBuilds.length} ADO pipeline builds`);

    // Detect build-level status changes
    const statusMap = new Map<string, string>();
    for (const build of allBuilds) {
      statusMap.set(String(build.id), compositeStatus(build));
    }
    const changes = this.buildWatcher.update(statusMap);
    await this.notifyBuildChanges(changes, allBuilds);

    // Early failure detection: check jobs within in-progress builds
    const inProgressBuilds = allBuilds.filter(b => b.status === 'inProgress');
    if (inProgressBuilds.length > 0) {
      await this.checkJobFailures(accessToken, inProgressBuilds);
    }

    // Clean up notified job failures for builds no longer tracked
    const activeBuildIds = new Set(allBuilds.map(b => b.id));
    for (const buildId of this.notifiedJobFailures.keys()) {
      if (!activeBuildIds.has(buildId)) {
        this.notifiedJobFailures.delete(buildId);
      }
    }

    // Emit only non-completed builds as DiscoveredItems
    const activeBuilds = allBuilds.filter(b => b.status !== 'completed');
    const items: DiscoveredItem[] = activeBuilds.map(build => ({
      externalId: `pipelines:${build.project.name}/builds/${build.id}`,
      title: `${build.definition.name} #${build.buildNumber}`,
      description: `${formatBranch(build.sourceBranch)} · ${build.status}`,
      url: build._links.web.href,
      group: build.project.name,
      state: build.status,
    }));

    this._onDidDiscoverItems.fire(items);

    if (fetchFailures.length > 0) {
      const msg = fetchFailures.length === 1
        ? `Failed to fetch pipeline builds from ${fetchFailures[0]}`
        : `Failed to fetch pipeline builds from ${fetchFailures.length} sources`;
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`DevDocket ADO: ${msg}`);
      }
      logger.warn(msg);
    }
  }

  /** Fetch recent builds for a single organization/project. */
  private async fetchBuilds(token: string, org: string, project: string): Promise<AdoBuild[]> {
    const target = project ? `${org}/${project}` : org;
    logger.debug(`Fetching pipeline builds for ${target}`);

    const projectPath = project ? `/${encodeURIComponent(project)}` : '';
    const url = `https://dev.azure.com/${encodeURIComponent(org)}${projectPath}/_apis/build/builds?$top=20&api-version=7.1`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(`ADO API returned ${response.status} for ${target} pipeline builds`);
    }

    const data = (await response.json()) as { count: number; value: AdoBuild[] };
    return data.value;
  }

  /** Fire VS Code notifications for detected build status changes. */
  private async notifyBuildChanges(changes: StatusChange<string>[], builds: AdoBuild[]): Promise<void> {
    const buildById = new Map(builds.map(b => [String(b.id), b]));

    for (const change of changes) {
      const build = buildById.get(change.id);
      if (!build) { continue; }

      const branch = formatBranch(build.sourceBranch);
      const label = `${build.definition.name} #${build.buildNumber}`;

      if (change.currentStatus === 'completed:succeeded') {
        const result = await vscode.window.showInformationMessage(
          `✅ ${label} succeeded (${build.project.name}, ${branch})`,
          'View Build',
        );
        if (result === 'View Build') {
          void vscode.env.openExternal(vscode.Uri.parse(build._links.web.href));
        }
      } else if (change.currentStatus === 'completed:failed') {
        const result = await vscode.window.showWarningMessage(
          `❌ ${label} failed (${build.project.name}, ${branch})`,
          'View Build',
        );
        if (result === 'View Build') {
          void vscode.env.openExternal(vscode.Uri.parse(build._links.web.href));
        }
      } else if (change.currentStatus === 'completed:canceled') {
        logger.info(`ADO build ${label} was cancelled (${build.project.name}, ${branch})`);
      }
    }
  }

  /**
   * Check in-progress builds for individual job failures and fire early
   * notifications. Each job failure is only notified once per build.
   */
  private async checkJobFailures(token: string, builds: AdoBuild[]): Promise<void> {
    let nextIndex = 0;
    const maxConcurrent = Math.min(3, builds.length);

    const runWorker = async (): Promise<void> => {
      while (nextIndex < builds.length) {
        const idx = nextIndex++;
        const build = builds[idx];
        try {
          const jobs = await this.fetchBuildJobs(token, build);
          const failedJobs = jobs.filter(j => j.state === 'completed' && j.result === 'failed');

          const notified = this.notifiedJobFailures.get(build.id) ?? new Set<string>();
          for (const job of failedJobs) {
            const jobKey = `${job.id}:${job.name}`;
            if (!notified.has(jobKey)) {
              notified.add(jobKey);
              const branch = formatBranch(build.sourceBranch);
              const result = await vscode.window.showWarningMessage(
                `⚠️ Job "${job.name}" failed in ${build.definition.name} #${build.buildNumber} (${build.project.name}, ${branch})`,
                'View Build',
              );
              if (result === 'View Build') {
                void vscode.env.openExternal(vscode.Uri.parse(build._links.web.href));
              }
            }
          }
          this.notifiedJobFailures.set(build.id, notified);
        } catch (err) {
          logger.debug(`Failed to fetch timeline for build ${build.id}: ${String(err)}`);
        }
      }
    };

    await Promise.all(Array.from({ length: maxConcurrent }, () => runWorker()));
  }

  /** Fetch job-level timeline records for a build. */
  private async fetchBuildJobs(token: string, build: AdoBuild): Promise<TimelineRecord[]> {
    const url = `https://dev.azure.com/${encodeURIComponent(build.project.name)}/_apis/build/builds/${build.id}/timeline?api-version=7.1`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      logger.debug(`Failed to fetch timeline for build ${build.id}: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as { records: TimelineRecord[] };
    // Only return Job-type records (not stages, tasks, etc.)
    return (data.records ?? []).filter(r => r.type === 'Job');
  }

  override dispose(): void {
    this.buildWatcher.clear();
    this.notifiedJobFailures.clear();
    super.dispose();
  }
}
