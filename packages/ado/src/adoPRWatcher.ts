import type {
  DevDocketPRWatcher,
  PRIdentifier,
  PRRunsSnapshot,
  PRState,
  RunIdentifier,
  CancellationTokenLike,
} from '@devdocket/shared';
import { safeDecodeComponent } from '@devdocket/shared';
import { getAdoHeaders, throwAdoApiError } from './adoAuth';
import { logger } from './logger';

interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  status: 'active' | 'completed' | 'abandoned';
  mergeStatus: string;
  lastMergeSourceCommit?: { commitId: string };
}

interface AdoBuild {
  id: number;
  buildNumber: string;
  definition: { name: string };
  status: string;
  result: string | null;
}

const FETCH_TIMEOUT_MS = 30_000;
const ADO_PR_URL_RE = /^\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)\/?$/;

/**
 * Watcher for Azure DevOps pull request pipeline runs.
 * Resolves PR URLs to their associated ADO pipeline builds.
 */
export class AdoPRWatcher implements DevDocketPRWatcher {
  readonly id = 'ado-pr';
  readonly label = 'Azure DevOps Pull Requests';

  canWatch(url: string): boolean {
    try {
      const u = new URL(url);
      return (u.protocol === 'https:' || u.protocol === 'http:')
        && u.hostname === 'dev.azure.com'
        && ADO_PR_URL_RE.test(u.pathname);
    } catch {
      return false;
    }
  }

  parsePRUrl(url: string): PRIdentifier {
    const u = new URL(url);
    const match = u.pathname.match(ADO_PR_URL_RE);
    if (!match) {
      throw new Error('Invalid Azure DevOps PR URL');
    }

    const [, rawOrg, rawProject, rawRepo, prId] = match;
    const org = safeDecodeComponent(rawOrg);
    const project = safeDecodeComponent(rawProject);
    const repo = safeDecodeComponent(rawRepo);

    return {
      providerId: this.id,
      prId,
      displayName: `PR #${prId}`,
      url,
      repo: `${org}/${project}/${repo}`,
    };
  }

  async getPRRunsSnapshot(
    identifier: PRIdentifier,
    token?: CancellationTokenLike,
  ): Promise<PRRunsSnapshot> {
    const repoParts = identifier.repo.split('/');
    const [org, project, repo] = repoParts;
    const encodedOrg = encodeURIComponent(org);
    const encodedProject = encodeURIComponent(project);
    const encodedRepo = encodeURIComponent(repo);
    const encodedPrId = encodeURIComponent(identifier.prId);

    const headers = await getAdoHeaders();

    if (token?.isCancellationRequested) {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }

    // Fetch PR details
    const prUrl = `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/git/repositories/${encodedRepo}/pullrequests/${encodedPrId}?api-version=7.1`;
    let prResponse: Response;
    try {
      prResponse = await fetch(prUrl, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`ADO API request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    }
    if (!prResponse.ok) {
      throwAdoApiError(prResponse, `PR ${identifier.prId}`);
    }
    const prData = await prResponse.json() as AdoPullRequest;

    // Map ADO PR status to PRState
    const prState: PRState = prData.status === 'active'
      ? 'open'
      : prData.status === 'completed'
        ? 'merged'
        : 'closed';

    const updatedDisplayName = prData.title
      ? `PR #${identifier.prId}: ${prData.title}`
      : undefined;

    if (token?.isCancellationRequested) {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }

    // Fetch builds for the PR's source branch
    const buildsUrl = `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/build/builds?reasonFilter=pullRequest&repositoryId=${encodedRepo}&repositoryType=TfsGit&api-version=7.1`;
    let buildsResponse: Response;
    try {
      buildsResponse = await fetch(buildsUrl, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        logger.warn(`ADO builds request timed out for PR ${identifier.prId}`);
        return { prState, runs: [] };
      }
      throw err;
    }

    const runs: RunIdentifier[] = [];
    if (buildsResponse.ok) {
      const buildsData = await buildsResponse.json() as { value: (AdoBuild & { triggerInfo?: { 'pr.number'?: string } })[] };

      for (const build of buildsData.value) {
        // Filter to builds triggered by this specific PR
        const prNumber = build.triggerInfo?.['pr.number'];
        if (prNumber !== identifier.prId) {
          continue;
        }

        const displayName = build.definition?.name
          ? `${build.definition.name} #${build.buildNumber}`
          : `Build ${build.buildNumber}`;

        runs.push({
          providerId: 'ado-pipelines',
          runId: String(build.id),
          displayName,
          url: `https://dev.azure.com/${org}/${project}/_build/results?buildId=${build.id}`,
          repo: `${org}/${project}`,
        });
      }
    } else {
      logger.warn(`Failed to fetch builds for PR ${identifier.prId}: ${buildsResponse.status} ${buildsResponse.statusText}`);
    }

    return { prState, runs, displayName: updatedDisplayName };
  }
}
