import * as vscode from 'vscode';
import {
  combineSignals,
  createAbortError,
  type CancellationTokenLike,
  type DevDocketRunWatcher,
  type JobStatus,
  type RunConclusion,
  type RunIdentifier,
  type RunState,
  type RunStatus,
} from '@devdocket/shared';
import { logger } from './logger';

interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral' | null;
  started_at?: string | null;
  completed_at?: string | null;
  app?: {
    slug?: string | null;
  } | null;
}

interface CancellationTokenWithEvent extends CancellationTokenLike {
  onCancellationRequested?: (listener: () => void) => { dispose(): void };
}

const CHECK_RUN_URL_RE = /^\/([^/]+)\/([^/]+)\/runs\/(\d+)\/?$/;
const FETCH_TIMEOUT_MS = 30_000;
const GITHUB_ADVANCED_SECURITY_APP_SLUG = 'github-advanced-security';

export class GitHubAdvancedSecurityWatcher implements DevDocketRunWatcher {
  readonly id = 'github-advanced-security';
  readonly label = 'GitHub Advanced Security';

  canWatch(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === 'https:'
        && u.hostname === 'github.com'
        && CHECK_RUN_URL_RE.test(u.pathname);
    } catch {
      return false;
    }
  }

  parseRunUrl(url: string): RunIdentifier {
    const u = new URL(url);
    const match = u.pathname.match(CHECK_RUN_URL_RE);
    if (!match) {
      throw new Error('Invalid GitHub Advanced Security check run URL');
    }

    const [, owner, repo, runId] = match;

    return {
      providerId: this.id,
      runId,
      displayName: 'GitHub Advanced Security',
      url,
      repo: `${owner}/${repo}`,
    };
  }

  async getRunStatus(identifier: RunIdentifier, token?: CancellationTokenLike): Promise<RunStatus> {
    if (!identifier.repo) {
      throw new Error('Repository required for GitHub Advanced Security run');
    }

    const repoParts = identifier.repo.split('/');
    if (repoParts.length !== 2 || repoParts.some(part => !part)) {
      throw new Error(`Invalid GitHub repo format: expected "owner/repo" but got "${identifier.repo}"`);
    }

    const [owner, repo] = repoParts;
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const encodedRunId = encodeURIComponent(identifier.runId);

    const checkRun = await this.fetchApi<GitHubCheckRun>(
      `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/check-runs/${encodedRunId}`,
      token,
    );

    if (checkRun.app?.slug !== GITHUB_ADVANCED_SECURITY_APP_SLUG) {
      throw new Error(`Expected GitHub Advanced Security check run but found app '${checkRun.app?.slug ?? 'unknown'}'`);
    }

    const overallState = this.mapState(checkRun.status);
    const conclusion = checkRun.conclusion ? this.mapConclusion(checkRun.conclusion) : undefined;
    const job: JobStatus = {
      id: String(checkRun.id),
      name: checkRun.name,
      state: overallState,
      conclusion,
      startedAt: checkRun.started_at ?? undefined,
      completedAt: checkRun.completed_at ?? undefined,
    };

    return {
      overallState,
      conclusion,
      displayName: checkRun.name,
      jobs: [job],
      startedAt: checkRun.started_at ?? undefined,
      completedAt: overallState === 'completed' ? checkRun.completed_at ?? undefined : undefined,
    };
  }

  private mapState(state: string): RunState {
    switch (state) {
      case 'completed':
        return 'completed';
      case 'in_progress':
        return 'running';
      case 'queued':
      case 'waiting':
      case 'requested':
      case 'pending':
        return 'queued';
      default:
        logger.warn(`Unknown run status '${state}', treating as queued`);
        return 'queued';
    }
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

  private async fetchApi<T>(url: string, token?: CancellationTokenLike): Promise<T> {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
    if (!session) {
      throw new Error('No GitHub authentication session available. Sign in to GitHub to watch security runs.');
    }

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${session.accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'DevDocket-VSCode',
    };

    let request: { signal: AbortSignal; dispose(): void } | undefined;
    try {
      request = this.createRequestSignal(token);
      const response = await fetch(url, {
        headers,
        signal: request.signal,
      });

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
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        if (token?.isCancellationRequested) {
          throw createAbortError();
        }
        if (request?.signal.aborted && request.signal.reason instanceof Error && request.signal.reason.name === 'TimeoutError') {
          throw new Error(`GitHub API request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
        }
        throw err;
      }
      throw err;
    } finally {
      request?.dispose();
    }
  }

  private createRequestSignal(token?: CancellationTokenLike): { signal: AbortSignal; dispose(): void } {
    if (token?.isCancellationRequested) {
      throw createAbortError();
    }

    const controller = new AbortController();
    const cancellationToken = token as CancellationTokenWithEvent | undefined;
    const disposable = cancellationToken?.onCancellationRequested?.(() => controller.abort(createAbortError()));
    const signal = combineSignals(controller.signal, FETCH_TIMEOUT_MS);
    let disposed = false;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      disposable?.dispose();
      if (!controller.signal.aborted) {
        controller.abort(createAbortError());
      }
    };
    signal.addEventListener('abort', dispose, { once: true });
    return { signal, dispose };
  }
}
