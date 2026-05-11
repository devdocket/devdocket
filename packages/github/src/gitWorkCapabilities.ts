import { combineSignals, isValidGitHubRepo, type GitWorkInfo } from '@devdocket/shared';
import { getHeaders, retryWithAuth } from './githubApiHelpers';
import { logger } from './logger';

interface GitHubPrGitWorkResponse {
  head?: {
    ref?: unknown;
    repo?: {
      full_name?: unknown;
      clone_url?: unknown;
    } | null;
  };
  base?: {
    ref?: unknown;
    repo?: {
      full_name?: unknown;
      clone_url?: unknown;
    } | null;
  };
}

export function createGitHubIssueGitWork(repoName: string, number: number): GitWorkInfo | undefined {
  if (!isValidGitHubRepo(repoName)) {
    logger.warn(`Skipping GitHub issue git work for invalid repo name: ${repoName}`);
    return undefined;
  }

  return {
    kind: 'issue',
    cloneUrl: `https://github.com/${repoName}.git`,
    ref: `issue${number}`,
    repoLabel: repoName,
  };
}

export function createGitHubPrGitWork(repoName: string, number: number, prApiUrl?: string): (() => Promise<GitWorkInfo | undefined>) | undefined {
  if (!isValidGitHubRepo(repoName)) {
    logger.warn(`Skipping GitHub PR git work for invalid repo name: ${repoName}`);
    return undefined;
  }

  return async () => {
    // Resolve the head repo/ref at action time so fork and branch data are current.
    const url = prApiUrl ?? buildGitHubPrApiUrl(repoName, number);
    if (!url) {
      return undefined;
    }
    const headers = await getHeaders();
    const wasAuthenticated = 'Authorization' in headers;
    let response = await fetch(url, {
      headers,
      signal: combineSignals(undefined, 30_000),
    });

    if ((response.status === 401 || response.status === 403 || (response.status === 404 && !wasAuthenticated))) {
      const retryResponse = await retryWithAuth(url);
      if (retryResponse) { response = retryResponse; }
    }

    if (!response.ok) {
      logger.info(`GitHub PR API returned ${response.status} while resolving git work info for ${repoName}#${number}`);
      return undefined;
    }

    const pr = await response.json() as GitHubPrGitWorkResponse;
    const headRef = typeof pr.head?.ref === 'string' ? pr.head.ref : undefined;
    const headRepo = pr.head?.repo;
    const headRepoFullName = typeof headRepo?.full_name === 'string' ? headRepo.full_name : undefined;
    const headCloneUrl = typeof headRepo?.clone_url === 'string' ? headRepo.clone_url : undefined;
    const baseRepo = pr.base?.repo;
    const baseRepoFullName = typeof baseRepo?.full_name === 'string' ? baseRepo.full_name : repoName;
    const baseCloneUrl = typeof baseRepo?.clone_url === 'string'
      ? baseRepo.clone_url
      : `https://github.com/${baseRepoFullName}.git`;
    const baseRef = typeof pr.base?.ref === 'string' ? pr.base.ref : undefined;

    if (!headRef || !headCloneUrl) {
      logger.info(`GitHub PR ${repoName}#${number} is missing head repo information`);
      return undefined;
    }

    const isFork = !!headRepoFullName && headRepoFullName !== baseRepoFullName;
    return {
      kind: 'pr',
      cloneUrl: baseCloneUrl,
      ref: headRef,
      ...(isFork ? { headCloneUrl } : {}),
      ...(baseRef ? { baseRef } : {}),
      repoLabel: baseRepoFullName,
    };
  };
}

function buildGitHubPrApiUrl(repoName: string, number: number): string | undefined {
  if (!isValidGitHubRepo(repoName)) {
    return undefined;
  }
  const [owner, repo] = repoName.split('/');
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
}
