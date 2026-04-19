import * as vscode from 'vscode';
import { StatusWatcher, type StatusChange, isValidGitHubRepo } from '@devdocket/shared';
import { logger } from './logger';
import { BaseGitHubProvider, DiscoveredItem } from './baseGithubProvider';

/** GitHub Actions workflow run from the REST API. */
interface WorkflowRun {
  id: number;
  name: string;
  run_number: number;
  status: string;
  conclusion: string | null;
  head_branch: string;
  html_url: string;
  event: string;
  repository: { full_name: string };
  created_at: string;
  updated_at: string;
}

interface WorkflowRunsResponse {
  total_count: number;
  workflow_runs: WorkflowRun[];
}

/** A single job within a workflow run. */
interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

interface WorkflowJobsResponse {
  total_count: number;
  jobs: WorkflowJob[];
}

/**
 * Compose a trackable status string from a workflow run.
 * For completed runs, includes the conclusion (e.g. `completed:failure`).
 */
function compositeStatus(run: WorkflowRun): string {
  if (run.status === 'completed' && run.conclusion) {
    return `completed:${run.conclusion}`;
  }
  return run.status;
}

/** Format a branch name by stripping the refs/heads/ prefix if present. */
function formatBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, '');
}

/**
 * DevDocket provider that watches GitHub Actions workflow runs for status
 * changes and fires VS Code notifications on completion or failure.
 *
 * Fetches recent workflow runs from configured repositories, tracks their
 * status across polling cycles, and detects both run-level transitions
 * (e.g. in_progress → completed:failure) and early individual job failures
 * within in-progress runs.
 *
 * Active (non-completed) runs are emitted as {@link DiscoveredItem}s so
 * they appear in the Sources and Inbox views.
 */
export class GitHubActionsProvider extends BaseGitHubProvider {
  readonly id = 'github-actions';
  readonly label = 'GitHub Actions';

  private readonly runWatcher = new StatusWatcher<string>();
  /** Tracks which job failures have already been notified per run to avoid duplicates. */
  private readonly notifiedJobFailures = new Map<number, Set<string>>();

  protected async fetchAndPublish(accessToken: string, isUserTriggered: boolean): Promise<void> {
    logger.info('Fetching GitHub Actions workflow runs...');
    const repos = this.getConfiguredRepos();

    if (repos.length === 0) {
      logger.debug('No repos configured — skipping GitHub Actions fetch');
      this.runWatcher.update(new Map());
      this.notifiedJobFailures.clear();
      this._onDidDiscoverItems.fire([]);
      return;
    }

    const validRepos = repos.filter(repo => {
      if (!isValidGitHubRepo(repo)) {
        logger.warn('Skipping invalid repo identifier for Actions', repo);
        return false;
      }
      return true;
    });

    const allRuns: WorkflowRun[] = [];
    const failures: string[] = [];

    const results = await Promise.allSettled(
      validRepos.map(repo => this.fetchRepoRuns(accessToken, repo)),
    );

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allRuns.push(...result.value);
      } else {
        failures.push(validRepos[index]);
        logger.error(`Failed to fetch workflow runs for ${validRepos[index]}`, result.reason);
      }
    });

    logger.info(`Fetched ${allRuns.length} workflow runs across ${validRepos.length} repos`);

    // Detect run-level status changes
    const statusMap = new Map<string, string>();
    for (const run of allRuns) {
      statusMap.set(String(run.id), compositeStatus(run));
    }
    const changes = this.runWatcher.update(statusMap);
    await this.notifyRunChanges(changes, allRuns);

    // Early failure detection: check jobs within in-progress runs
    const inProgressRuns = allRuns.filter(r => r.status === 'in_progress');
    if (inProgressRuns.length > 0) {
      await this.checkJobFailures(accessToken, inProgressRuns);
    }

    // Clean up notified job failures for runs that are no longer tracked
    const activeRunIds = new Set(allRuns.map(r => r.id));
    for (const runId of this.notifiedJobFailures.keys()) {
      if (!activeRunIds.has(runId)) {
        this.notifiedJobFailures.delete(runId);
      }
    }

    // Emit only non-completed runs as DiscoveredItems
    const activeRuns = allRuns.filter(r => r.status !== 'completed');
    const items: DiscoveredItem[] = activeRuns.map(run => ({
      externalId: `actions:${run.repository.full_name}/runs/${run.id}`,
      title: `${run.name} #${run.run_number}`,
      description: `${formatBranch(run.head_branch)} · ${run.event} · ${run.status}`,
      url: run.html_url,
      group: run.repository.full_name,
      state: run.status,
    }));

    this._onDidDiscoverItems.fire(items);

    if (failures.length > 0) {
      const msg = failures.length === 1
        ? `Failed to fetch workflow runs from ${failures[0]}`
        : `Failed to fetch workflow runs from ${failures.length} repositories`;
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`DevDocket GitHub: ${msg}`);
      }
      logger.warn(msg);
    }
  }

  private getConfiguredRepos(): string[] {
    const config = vscode.workspace.getConfiguration('devdocketGithub');
    return config.get<string[]>('repos', []);
  }

  /**
   * Fetch recent workflow runs for a single repository.
   * Returns both in-progress and recently completed runs so the StatusWatcher
   * can detect transitions.
   */
  private async fetchRepoRuns(token: string, repo: string): Promise<WorkflowRun[]> {
    logger.debug(`Fetching workflow runs for ${repo}`);
    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs?per_page=20`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status} for ${repo} workflow runs`);
    }

    const data = (await response.json()) as WorkflowRunsResponse;
    return data.workflow_runs;
  }

  /**
   * Fire VS Code notifications for detected run status changes.
   */
  private async notifyRunChanges(changes: StatusChange<string>[], runs: WorkflowRun[]): Promise<void> {
    const runById = new Map(runs.map(r => [String(r.id), r]));

    for (const change of changes) {
      const run = runById.get(change.id);
      if (!run) { continue; }

      const branch = formatBranch(run.head_branch);
      const label = `${run.name} #${run.run_number}`;

      if (change.currentStatus === 'completed:success') {
        const result = await vscode.window.showInformationMessage(
          `✅ ${label} succeeded (${run.repository.full_name}, ${branch})`,
          'View Run',
        );
        if (result === 'View Run') {
          void vscode.env.openExternal(vscode.Uri.parse(run.html_url));
        }
      } else if (change.currentStatus === 'completed:cancelled') {
        logger.info(`Workflow run ${label} was cancelled (${run.repository.full_name}, ${branch})`);
      } else if (change.currentStatus.startsWith('completed:')) {
        const conclusion = change.currentStatus.slice('completed:'.length);
        const outcome = conclusion === 'failure' ? 'failed' : `completed with conclusion "${conclusion}"`;
        const result = await vscode.window.showWarningMessage(
          `❌ ${label} ${outcome} (${run.repository.full_name}, ${branch})`,
          'View Run',
        );
        if (result === 'View Run') {
          void vscode.env.openExternal(vscode.Uri.parse(run.html_url));
        }
      }
    }
  }

  /**
   * Check in-progress runs for individual job failures and fire early
   * notifications. Each job failure is only notified once per run.
   */
  private async checkJobFailures(token: string, runs: WorkflowRun[]): Promise<void> {
    let nextIndex = 0;
    const maxConcurrent = Math.min(3, runs.length);

    const runWorker = async (): Promise<void> => {
      while (nextIndex < runs.length) {
        const idx = nextIndex++;
        const run = runs[idx];
        try {
          const jobs = await this.fetchRunJobs(token, run);
          // Detect any non-success terminal job conclusions (failure, timed_out, action_required, etc.)
          const silentConclusions = new Set(['success', 'cancelled', 'skipped', null]);
          const failedJobs = jobs.filter(j => j.status === 'completed' && !silentConclusions.has(j.conclusion));

          const notified = this.notifiedJobFailures.get(run.id) ?? new Set<string>();
          for (const job of failedJobs) {
            const jobKey = `${job.id}:${job.name}`;
            if (!notified.has(jobKey)) {
              notified.add(jobKey);
              const branch = formatBranch(run.head_branch);
              const result = await vscode.window.showWarningMessage(
                `⚠️ Job "${job.name}" failed in ${run.name} #${run.run_number} (${run.repository.full_name}, ${branch})`,
                'View Job',
              );
              if (result === 'View Job') {
                void vscode.env.openExternal(vscode.Uri.parse(job.html_url));
              }
            }
          }
          this.notifiedJobFailures.set(run.id, notified);
        } catch (err) {
          logger.debug(`Failed to fetch jobs for run ${run.id}: ${String(err)}`);
        }
      }
    };

    await Promise.all(Array.from({ length: maxConcurrent }, () => runWorker()));
  }

  private async fetchRunJobs(token: string, run: WorkflowRun): Promise<WorkflowJob[]> {
    const response = await fetch(
      `https://api.github.com/repos/${run.repository.full_name}/actions/runs/${run.id}/jobs?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      logger.debug(`Failed to fetch jobs for run ${run.id}: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as WorkflowJobsResponse;
    return data.jobs;
  }

  override dispose(): void {
    this.runWatcher.clear();
    this.notifiedJobFailures.clear();
    super.dispose();
  }
}
