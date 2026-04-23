import * as vscode from 'vscode';
import type {
  DevDocketPRWatcher,
  PRIdentifier,
  PRRunsSnapshot,
  PRState,
  RunIdentifier,
  CancellationTokenLike,
} from '@devdocket/shared';

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
  details_url?: string;
  app?: { slug?: string };
  check_suite?: { id: number };
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
    const repoParts = identifier.repo.split('/');
    if (repoParts.length !== 2 || repoParts.some(p => !p)) {
      throw new Error(`Invalid GitHub repo format: expected "owner/repo" but got "${identifier.repo}"`);
    }
    const [owner, repo] = repoParts;
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

    const updatedDisplayName = prData.title
      ? `PR #${identifier.prId}: ${prData.title}`
      : undefined;

    // Fetch check runs for head commit
    const checkRunsData = await this.fetchApi<{ check_runs: GitHubCheckRun[] }>(
      `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/commits/${prData.head.sha}/check-runs?per_page=100`,
      token,
    );

    const runs: RunIdentifier[] = [];
    // Track GitHub Actions workflow runs by run ID to avoid duplicates
    // (multiple check runs/jobs share the same workflow run)
    const seenGHARunIds = new Set<string>();

    for (const cr of checkRunsData.check_runs) {
      // GitHub Actions checks: extract workflow run ID from URL and deduplicate
      const runIdMatch = cr.html_url.match(/\/actions\/runs\/(\d+)/);
      if (runIdMatch) {
        const runId = runIdMatch[1];
        if (seenGHARunIds.has(runId)) {
          continue;
        }
        seenGHARunIds.add(runId);

        runs.push({
          providerId: 'github-actions',
          runId,
          displayName: cr.name,
          url: `https://github.com/${owner}/${repo}/actions/runs/${runId}`,
          repo: `${owner}/${repo}`,
        });
        continue;
      }

      // Non-GitHub-Actions checks: use details_url for run watcher matching
      const checkUrl = cr.details_url || cr.html_url;
      runs.push({
        providerId: cr.app?.slug || 'check-run',
        runId: String(cr.id),
        displayName: cr.name,
        url: checkUrl,
        repo: `${owner}/${repo}`,
      });
    }

    return { prState, runs, displayName: updatedDisplayName };
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
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
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
