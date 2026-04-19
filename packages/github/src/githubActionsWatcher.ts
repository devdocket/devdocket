import * as vscode from 'vscode';
import type { 
  DevDocketRunWatcher, 
  RunIdentifier, 
  RunStatus, 
  JobStatus, 
  RunState, 
  RunConclusion 
} from '@devdocket/shared';


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
      return u.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/actions\/runs\/\d+/.test(u.pathname);
    } catch {
      return false;
    }
  }

  parseRunUrl(url: string): RunIdentifier {
    const u = new URL(url);
    const match = u.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);
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

  async getRunStatus(identifier: RunIdentifier, token?: vscode.CancellationToken): Promise<RunStatus> {
    if (!identifier.repo) {
      throw new Error('Repository required for GitHub Actions run');
    }

    const [owner, repo] = identifier.repo.split('/');
    
    // Fetch run details
    const runData = await this.fetchApi<GitHubWorkflowRun>(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${identifier.runId}`,
      token
    );

    // Fetch jobs for this run
    const jobsData = await this.fetchApi<{ jobs: GitHubWorkflowJob[] }>(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${identifier.runId}/jobs`,
      token
    );

    // Update display name with actual workflow name
    identifier.displayName = runData.name;

    const overallState = this.mapState(runData.status);
    const conclusion = runData.conclusion ? this.mapConclusion(runData.conclusion) : undefined;

    const jobs: JobStatus[] = jobsData.jobs.map(job => ({
      name: job.name,
      state: this.mapState(job.status),
      conclusion: job.conclusion ? this.mapConclusion(job.conclusion) : undefined,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    }));

    return {
      overallState,
      conclusion,
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

  private mapConclusion(conclusion: string): RunConclusion {
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
        return undefined;
    }
  }

  private async fetchApi<T>(url: string, token?: vscode.CancellationToken): Promise<T> {
    // Get GitHub authentication session
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
    if (!session) {
      throw new Error('GitHub authentication required. Please sign in to GitHub.');
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
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return await response.json() as T;
  }
}
