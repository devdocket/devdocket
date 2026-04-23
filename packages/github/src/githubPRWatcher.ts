import * as vscode from 'vscode';
import type {
  DevDocketPRWatcher,
  PRIdentifier,
  PRRunsSnapshot,
  PRState,
  RunIdentifier,
  CancellationTokenLike,
} from '@devdocket/shared';
import { logger } from './logger';

interface GitHubPR {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: { sha: string };
}

interface GitHubCheckRun {
  id: number;
  name: string;
  html_url: string;
  app?: { slug?: string };
  check_suite?: { id: number };
}

interface GitHubWorkflowRun {
  id: number;
  name: string;
  html_url: string;
}

const FETCH_TIMEOUT_MS = 30_000;
const PR_URL_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

/**
 * Watcher for GitHub pull request pipeline runs.
 * Resolves PR URLs to their associated GitHub Actions workflow runs.
 */
export class GitHubPRWatcher implements DevDocketPRWatcher {
  readonly id = 'github-pr';
  readonly label = 'GitHub Pull Requests';

  canWatch(url: string): boolean {
    try {
      const u = new URL(url);
      return (u.protocol === 'https:' || u.protocol === 'http:')
        && u.hostname === 'github.com'
        && PR_URL_RE.test(u.pathname);
    } catch {
      return false;
    }
  }

  parsePRUrl(url: string): PRIdentifier {
    const u = new URL(url);
    const match = u.pathname.match(PR_URL_RE);
    if (!match) {
      throw new Error('Invalid GitHub PR URL');
    }

    const [, owner, repo, prNumber] = match;

    return {
      providerId: this.id,
      prId: prNumber,
      displayName: `PR #${prNumber}`,
      url,
      repo: `${owner}/${repo}`,
    };
  }

  async getPRRunsSnapshot(
    identifier: PRIdentifier,
    token?: CancellationTokenLike,
  ): Promise<PRRunsSnapshot> {
    const [owner, repo] = identifier.repo.split('/');
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const encodedPrNumber = encodeURIComponent(identifier.prId);

    // Fetch PR details to get state and head SHA
    const prData = await this.fetchApi<GitHubPR>(
      `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/pulls/${encodedPrNumber}`,
      token,
    );

    const prState: PRState = prData.merged
      ? 'merged'
      : prData.state === 'closed'
        ? 'closed'
        : 'open';

    // Update display name with PR title
    if (prData.title) {
      identifier.displayName = `PR #${identifier.prId}: ${prData.title}`;
    }

    // Fetch check runs for head commit
    const checkRunsData = await this.fetchApi<{ check_runs: GitHubCheckRun[] }>(
      `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/commits/${prData.head.sha}/check-runs?per_page=100`,
      token,
    );

    // Deduplicate by check_suite ID to get unique workflow runs
    const seenSuites = new Set<number>();
    const runs: RunIdentifier[] = [];

    for (const cr of checkRunsData.check_runs) {
      const suiteId = cr.check_suite?.id;
      if (suiteId && seenSuites.has(suiteId)) {
        continue;
      }
      if (suiteId) {
        seenSuites.add(suiteId);
      }

      // Extract workflow run ID from the check run's html_url
      const runIdMatch = cr.html_url.match(/\/actions\/runs\/(\d+)/);
      if (!runIdMatch) {
        continue;
      }

      const runId = runIdMatch[1];
      runs.push({
        providerId: 'github-actions',
        runId,
        displayName: cr.name,
        url: `https://github.com/${owner}/${repo}/actions/runs/${runId}`,
        repo: `${owner}/${repo}`,
      });
    }

    return { prState, runs };
  }

  private async fetchApi<T>(url: string, token?: CancellationTokenLike): Promise<T> {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
    if (!session) {
      throw new Error('No GitHub authentication session available. Sign in to GitHub to watch PR pipelines.');
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
      response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`GitHub API request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('PR not found or access denied');
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
