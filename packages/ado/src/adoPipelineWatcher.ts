import type {
  DevDocketRunWatcher,
  RunIdentifier,
  RunStatus,
  JobStatus,
  RunState,
  RunConclusion,
  CancellationTokenLike,
} from '@devdocket/shared';
import { getAdoHeaders, throwAdoApiError, safeDecodeComponent } from './adoAuth';
import { logger } from './logger';

interface AdoBuild {
  id: number;
  buildNumber: string;
  definition: { name: string };
  status: string;
  result: string | null;
  startTime?: string;
  finishTime?: string;
}

interface AdoTimelineRecord {
  id: string;
  name: string;
  type: string;
  state: string;
  result: string | null;
  startTime?: string;
  finishTime?: string;
}

export class AdoPipelineWatcher implements DevDocketRunWatcher {
  readonly id = 'ado-pipelines';
  readonly label = 'Azure DevOps Pipelines';

  canWatch(url: string): boolean {
    try {
      const u = new URL(url);
      return (u.protocol === 'https:' || u.protocol === 'http:')
        && u.hostname === 'dev.azure.com'
        && /^\/[^/]+\/[^/]+\/_build\/results\/?$/.test(u.pathname)
        && !!u.searchParams.get('buildId');
    } catch {
      return false;
    }
  }

  parseRunUrl(url: string): RunIdentifier {
    const u = new URL(url);
    const pathMatch = u.pathname.match(/^\/([^/]+)\/([^/]+)\/_build\/results\/?$/);
    if (!pathMatch) {
      throw new Error('Invalid Azure DevOps pipeline URL');
    }
    const buildId = u.searchParams.get('buildId');
    if (!buildId) {
      throw new Error('Missing buildId parameter in Azure DevOps pipeline URL');
    }

    const [, rawOrg, rawProject] = pathMatch;
    const org = safeDecodeComponent(rawOrg);
    const project = safeDecodeComponent(rawProject);

    return {
      providerId: this.id,
      runId: buildId,
      displayName: `Build ${buildId}`,
      url,
      repo: `${org}/${project}`,
    };
  }

  async getRunStatus(identifier: RunIdentifier, token?: CancellationTokenLike): Promise<RunStatus> {
    if (!identifier.repo) {
      throw new Error('Organization/project required for ADO pipeline run');
    }

    const [org, project] = identifier.repo.split('/');
    const encodedOrg = encodeURIComponent(org);
    const encodedProject = encodeURIComponent(project);
    const encodedBuildId = encodeURIComponent(identifier.runId);

    const headers = await getAdoHeaders();

    if (token?.isCancellationRequested) {
      throw new Error('Request cancelled');
    }

    // Fetch build details
    const buildUrl = `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/build/builds/${encodedBuildId}?api-version=7.1`;
    const buildResponse = await fetch(buildUrl, { headers });
    if (!buildResponse.ok) {
      throwAdoApiError(buildResponse, `Build ${identifier.runId}`);
    }
    const buildData = await buildResponse.json() as AdoBuild;

    // Update display name with pipeline definition name
    const displayName = buildData.definition?.name
      ? `${buildData.definition.name} #${buildData.buildNumber}`
      : `Build ${buildData.buildNumber}`;

    if (token?.isCancellationRequested) {
      throw new Error('Request cancelled');
    }

    // Fetch timeline for job details
    const timelineUrl = `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/build/builds/${encodedBuildId}/timeline?api-version=7.1`;
    const timelineResponse = await fetch(timelineUrl, { headers });

    let jobs: JobStatus[] = [];
    if (timelineResponse.ok) {
      const timelineData = await timelineResponse.json() as { records: AdoTimelineRecord[] };
      jobs = timelineData.records
        .filter(r => r.type === 'Job')
        .map(r => ({
          id: r.id,
          name: r.name,
          state: this.mapState(r.state),
          conclusion: r.result ? this.mapConclusion(r.result) : undefined,
          startedAt: r.startTime,
          completedAt: r.finishTime,
        }));
    } else {
      logger.warn(`Failed to fetch timeline for build ${identifier.runId}: ${timelineResponse.status} ${timelineResponse.statusText}`);
    }

    const overallState = this.mapState(buildData.status);
    const conclusion = buildData.result ? this.mapConclusion(buildData.result) : undefined;

    return {
      overallState,
      conclusion,
      displayName,
      jobs,
      startedAt: buildData.startTime,
      completedAt: buildData.finishTime,
    };
  }

  private mapState(state: string): RunState {
    switch (state) {
      case 'notStarted':
      case 'pending':
      case 'postponed':
        return 'queued';
      case 'inProgress':
      case 'cancelling':
        return 'running';
      case 'completed':
        return 'completed';
      default:
        logger.warn(`Unknown ADO build/timeline state '${state}', treating as running`);
        return 'running';
    }
  }

  private mapConclusion(result: string): RunConclusion | undefined {
    switch (result) {
      case 'succeeded':
        return 'success';
      case 'failed':
      case 'partiallySucceeded':
        return 'failure';
      case 'canceled':
        return 'cancelled';
      default:
        logger.warn(`Unknown ADO build result '${result}', treating as undefined`);
        return undefined;
    }
  }
}
