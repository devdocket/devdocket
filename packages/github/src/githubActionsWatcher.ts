import * as vscode from 'vscode';
import type { 
  DevDocketRunWatcher, 
  RunIdentifier, 
  RunStatus, 
  JobStatus, 
  RunState, 
  RunConclusion 
} from '@devdocket/shared';
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
      return u.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/?$/.test(u.pathname);
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
    };
  }

  async getRunStatus(identifier: RunIdentifier, token?: unknown): Promise<RunStatus> {
    if (!identifier.repo) {
      throw new Error('Repository required for GitHub Actions run');
    }

    const cancellationToken = token && typeof token === 'object' && 'isCancellationRequested' in token
      ? token as vscode.CancellationToken
      : undefined;
    const [owner, repo] = identifier.repo.split('/');
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const encodedRunId = encodeURIComponent(identifier.runId);
    
    // Fetch run details
    const runData = await this.fetchApi<GitHubWorkflowRun>(
      `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/actions/runs/${encodedRunId}`,
      cancellationToken
    );

    // Fetch jobs for this run
    const jobsData = await this.fetchApi<{ jobs: GitHubWorkflowJob[] }>(
      `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/actions/runs/${encodedRunId}/jobs`,
      cancellationToken
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

  private async fetchApi<T>(url: string, token?: vscode.CancellationToken): Promise<T> {
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

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Run not found or access denied');
      }
      if (response.status === 401) {
        throw new Error('GitHub authentication failed. Please re-authenticate.');
      }
      if (response.status === 403) {
        const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
        if (rateLimitRemaining === '0') {
          throw new Error('GitHub API rate limit exceeded. Please wait and try again.');
        }
        throw new Error('GitHub access denied. Check repository permissions.');
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return await response.json() as T;
  }
}
