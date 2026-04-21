import * as vscode from 'vscode';
import { isValidGitHubRepo, runWorkerPoolSettled } from '@devdocket/shared';
import { logger } from './logger';

export interface GitHubIssue {
  number: number;
  title: string;
  body?: string;
  state?: string;
  html_url: string;
  repository_url: string;
  pull_request?: { url: string };
}

/** Get GitHub API headers, attaching auth if a silent session is available. */
export async function getHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'DevDocket-VSCode',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  try {
    const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
    if (session) {
      headers['Authorization'] = `Bearer ${session.accessToken}`;
    }
  } catch {
    logger.debug('No GitHub auth session available, using unauthenticated request');
  }
  return headers;
}

/** Retry a request with interactive auth (prompts user to sign in). */
export async function retryWithAuth(apiUrl: string, signal?: AbortSignal): Promise<Response | undefined> {
  try {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    if (session) {
      return await fetch(apiUrl, {
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'DevDocket-VSCode',
          'X-GitHub-Api-Version': '2022-11-28',
          'Authorization': `Bearer ${session.accessToken}`,
        },
        signal,
      });
    }
  } catch {
    logger.debug('User declined GitHub authentication prompt');
  }
  return undefined;
}

/** Throw a descriptive error for a non-ok GitHub API response. */
export function throwApiError(response: Response, label: string): never {
  if (response.status === 404) {
    throw new Error(`${label} not found. It may be private or deleted.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`GitHub access denied for ${label}. The repo may be private — sign in to GitHub in VS Code, or check rate limits.`);
  }
  throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
}

/** Extract canonical owner/repo from a GitHub html_url. */
export function parseCanonicalRepo(htmlUrl: string, fallbackOwner: string, fallbackRepo: string): string {
  const match = htmlUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\//i);
  return match ? `${match[1]}/${match[2]}` : `${fallbackOwner}/${fallbackRepo}`;
}

/**
 * Shared implementation for getClosedItems across GitHub providers.
 * Parses external IDs ("owner/repo#number"), validates repo slugs, and
 * checks item state via the specified API endpoint using a worker pool.
 *
 * @param externalIds - External IDs in "owner/repo#number" format.
 * @param apiType - GitHub API path segment: `'issues'` or `'pulls'`.
 * @param signal - Optional abort signal for cancellation.
 * @returns External IDs whose GitHub state is `'closed'`.
 */
export async function fetchClosedGitHubItems(
  externalIds: string[],
  apiType: 'issues' | 'pulls',
  signal?: AbortSignal,
): Promise<string[]> {
  if (externalIds.length === 0) { return []; }

  let session: vscode.AuthenticationSession | undefined;
  try {
    session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
  } catch {
    logger.debug(`No GitHub auth session for getClosedItems (${apiType})`);
  }
  if (!session) { return []; }
  const token = session.accessToken;

  const parsed = externalIds.map(id => {
    const hashIdx = id.lastIndexOf('#');
    if (hashIdx === -1) { return null; }
    const rawRepo = id.substring(0, hashIdx);
    const rawNumber = id.substring(hashIdx + 1);
    if (!/^\d+$/.test(rawNumber) || !isValidGitHubRepo(rawRepo)) { return null; }
    const num = Number(rawNumber);
    const [owner, repoName] = rawRepo.split('/');
    return { id, owner, repoName, number: num };
  }).filter((p): p is NonNullable<typeof p> => p !== null);

  if (parsed.length === 0) { return []; }

  const results = await runWorkerPoolSettled(
    parsed,
    async (item) => {
      if (signal?.aborted) {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      }
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repoName)}/${apiType}/${item.number}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'DevDocket-VSCode',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal,
        },
      );
      if (!response.ok) {
        logger.debug(`Failed to check ${apiType} ${item.id}: ${response.status}`);
        return null;
      }
      const data = await response.json() as { state?: string };
      return data.state === 'closed' ? item.id : null;
    },
    5, // maxConcurrency
  );

  // Filter out nulls and errors, keep only the closed IDs
  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => (r as PromiseFulfilledResult<string | null>).value as string);
}
