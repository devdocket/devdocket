import * as vscode from 'vscode';
import type { 
  DevDocketRunWatcher, 
  RunIdentifier, 
  RunStatus, 
  JobStatus, 
  RunState, 
  RunConclusion,
  CancellationTokenLike 
} from '@devdocket/shared';
import { throwApiError } from './githubApiHelpers';
import { logger } from './logger';


interface GitHubWorkflowRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral' | null;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
}

interface GitHubWorkflowJob {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral' | null;
  started_at?: string;
  completed_at?: string;
}

/**
 * Watcher for GitHub Actions workflow runs.
 */
export class GitHubActionsWatcher implements DevDocketRunWatcher {
  readonly id = 'github-actions';
  readonly label = 'GitHub Actions';

  canWatch(url: string): boolean {
    try {
      const u = new URL(url);
      return (u.protocol === 'https:' || u.protocol === 'http:')
        && u.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/?$/.test(u.pathname);
    } catch {
      return false;
    }
  }

  parseRunUrl(url: string): RunIdentifier {
    const u = new URL(url);
    const match = u.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/?$/);
    if (!match) {
      throw new Error('Invalid GitHub Actions run URL');
    }

    const [, owner, repo, runId] = match;
    
    return {
      providerId: this.id,
      runId,
      displayName: 'CI Build', // We'll update this with the real name when we fetch status
      url,
      repo: `${owner}/${repo}`,
      backoffKey: 'api.github.com',
    };
  }

  async getRunStatus(identifier: RunIdentifier, token?: CancellationTokenLike): Promise<RunStatus> {
    if (!identifier.repo) {
      throw new Error('Repository required for GitHub Actions run');
    }

    const [owner, repo] = identifier.repo.split('/');
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const encodedRunId = encodeURIComponent(identifier.runId);
    
    // Fetch run details
    const runData = await this.fetchApi<GitHubWorkflowRun>(
      `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/actions/runs/${encodedRunId}`,
      token,
      `GitHub Actions run ${identifier.runId}`,
    );

    // Fetch jobs for this run (request max page size to avoid omitting jobs on larger workflows)
    const jobsData = await this.fetchApi<{ jobs: GitHubWorkflowJob[] }>(
      `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/actions/runs/${encodedRunId}/jobs?per_page=100`,
      token,
      `GitHub Actions jobs for run ${identifier.runId}`,
    );

    const overallState = this.mapState(runData.status);
    const conclusion = runData.conclusion ? this.mapConclusion(runData.conclusion) : undefined;

    const jobs: JobStatus[] = jobsData.jobs.map(job => ({
      id: String(job.id),
      name: job.name,
      state: this.mapState(job.status),
      conclusion: job.conclusion ? this.mapConclusion(job.conclusion) : undefined,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    }));

    return {
      overallState,
      conclusion,
      displayName: runData.name,
      jobs,
      startedAt: runData.run_started_at || runData.created_at,
      completedAt: overallState === 'completed' ? runData.updated_at : undefined,
    };
  }

  private mapState(state: 'queued' | 'in_progress' | 'completed'): RunState {
    if (state === 'in_progress') {
      return 'running';
    }
    return state;
  }

  private mapConclusion(conclusion: string): RunConclusion | undefined {
    switch (conclusion) {
      case 'success':
      case 'failure':
      case 'cancelled':
      case 'skipped':
      case 'timed_out':
      case 'action_required':
      case 'neutral':
        return conclusion;
      default:
        logger.warn(`Unknown run conclusion '${conclusion}', treating as undefined`);
        return undefined;
    }
  }

  private static readonly FETCH_TIMEOUT_MS = 30_000;

  private async fetchApi<T>(url: string, token: CancellationTokenLike | undefined, label: string): Promise<T> {
    // Background polling must not trigger interactive sign-in prompts.
    // Reuse an existing session if available; fail gracefully if not.
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
    if (!session) {
      throw new Error('No GitHub authentication session available. Sign in to GitHub to watch pipeline runs.');
    }

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${session.accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'DevDocket-VSCode',
    };

    if (token?.isCancellationRequested) {
      throw new Error('Request cancelled');
    }

    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(GitHubActionsWatcher.FETCH_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`GitHub API request timed out after ${GitHubActionsWatcher.FETCH_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    }

    if (!response.ok) {
      await throwApiError(response, label);
    }

    return await response.json() as T;
  }
}
