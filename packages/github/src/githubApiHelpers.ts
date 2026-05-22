import * as vscode from 'vscode';
import { isValidGitHubRepo, combineSignals, createAbortError, getSessionWithAuthFallback, runWorkerPoolSettled, type ProviderBadge } from '@devdocket/shared';
import { logger } from './logger';

export interface GitHubAuthOptions {
  interactive?: boolean;
  signal?: AbortSignal;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body?: string;
  state?: string;
  html_url: string;
  repository_url: string;
  comments_url?: string;
  comments?: number;
  updated_at?: string;
  user?: {
    login?: string;
    avatar_url?: string;
    html_url?: string;
  };
  pull_request?: { url: string };
  merged_at?: string | null;
  merged?: boolean;
}

export interface GitHubSearchResponse {
  items: GitHubIssue[];
}

export interface GitHubPrMergeFields {
  state?: string;
  merged_at?: string | null;
  merged?: boolean;
}

export function isMergedGitHubPr(item: GitHubPrMergeFields): boolean {
  if (item.merged_at) {
    return true;
  }
  return item.state?.toLowerCase() === 'closed' && item.merged === true;
}

export async function filterMergedGitHubPrs(
  token: string,
  items: GitHubIssue[],
  signal?: AbortSignal,
): Promise<GitHubIssue[]> {
  const mergedUrls = new Set<string>();
  const detailCandidates: GitHubIssue[] = [];

  for (const item of items) {
    if (!item.pull_request) {
      continue;
    }
    if (isMergedGitHubPr(item)) {
      mergedUrls.add(item.html_url);
      continue;
    }
    if (item.state?.toLowerCase() === 'closed' && item.pull_request.url) {
      detailCandidates.push(item);
    }
  }

  if (detailCandidates.length > 0) {
    const results = await runWorkerPoolSettled(
      detailCandidates,
      async (item) => {
        if (signal?.aborted) {
          throw createAbortError();
        }
        try {
          const response = await fetch(item.pull_request!.url, {
            headers: getGitHubAuthHeaders(token),
            signal: combineSignals(signal, 30_000),
          });
          if (!response.ok) {
            logger.debug(`Failed to fetch PR merge details for ${item.html_url}: ${response.status}`);
            return { htmlUrl: item.html_url, merged: false };
          }
          const detail = await response.json() as GitHubPrMergeFields;
          return { htmlUrl: item.html_url, merged: isMergedGitHubPr(detail) };
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError' && signal?.aborted) { throw error; }
          logger.debug(`Failed to fetch PR merge details for ${item.html_url}: ${String(error)}`);
          return { htmlUrl: item.html_url, merged: false };
        }
      },
      3,
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        logger.debug(`Failed to inspect PR merge details: ${String(result.reason)}`);
        continue;
      }
      if (result.value.merged) {
        mergedUrls.add(result.value.htmlUrl);
      }
    }
  }

  return items.filter(item => !mergedUrls.has(item.html_url));
}

/**
 * Builds the editor-only state badge for a GitHub issue or PR. Returns an
 * empty array when no state is provided so the result can be spread into a
 * badges list unconditionally. Open items render as info; everything else
 * (closed, merged, etc.) is shown as a neutral pill.
 */
export function buildIssueStateBadge(state?: string): ProviderBadge[] {
  if (!state) {
    return [];
  }
  const normalized = state.toLowerCase();
  const label = state.charAt(0).toUpperCase() + state.slice(1).toLowerCase();
  return [{
    label,
    variant: normalized === 'open' ? 'info' : 'neutral',
    show: 'editor',
  }];
}

/**
 * Returns GitHub REST API headers for an authenticated request using the provided token.
 * Used by all provider fetch methods that have an access token available.
 */
export function getGitHubAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
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

export async function getGitHubSession(
  scopes: readonly string[],
  options: GitHubAuthOptions = {},
): Promise<vscode.AuthenticationSession | undefined> {
  return getSessionWithAuthFallback({
    interactive: options.interactive,
    signal: options.signal,
    getSilent: () => vscode.authentication.getSession('github', [...scopes], { silent: true }),
    getInteractive: () => vscode.authentication.getSession('github', [...scopes], { createIfNone: true }),
  });
}

/** Retry a request with GitHub auth, prompting only for interactive callers. */
export async function retryWithAuth(
  apiUrl: string,
  signal?: AbortSignal,
  options: Omit<GitHubAuthOptions, 'signal'> = {},
): Promise<Response | undefined> {
  try {
    const session = await getGitHubSession(['repo'], { ...options, signal });
    if (session) {
      const requestSignal = signal ? combineSignals(signal, 30_000) : AbortSignal.timeout(30_000);
      return await fetch(apiUrl, {
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'DevDocket-VSCode',
          'X-GitHub-Api-Version': '2022-11-28',
          'Authorization': `Bearer ${session.accessToken}`,
        },
        signal: requestSignal,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    logger.debug('User declined GitHub authentication prompt');
  }
  return undefined;
}

/**
 * Inspect a non-ok GitHub API response and throw a descriptive error.
 *
 * Reads the response body (best-effort) and any diagnostic headers, logs a
 * warning with the real HTTP status / headers / body snippet, and then throws
 * an Error whose message describes the *actual* failure signature (rate limit,
 * SSO, authentication, not-found, etc.) instead of defaulting to a generic
 * "may be private" hint for every 4xx.
 *
 * Always throws — the `Promise<never>` return type lets callers `await` it
 * inside an `if (!response.ok)` branch.
 */
export async function throwApiError(response: Response, label: string): Promise<never> {
  const status = response.status;
  const statusText = response.statusText ?? '';
  const bodyText = await safeReadResponseBody(response);
  const apiMessage = extractGitHubApiMessage(bodyText);

  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  const retryAfter = response.headers.get('retry-after');
  const sso = response.headers.get('x-github-sso');

  const bodySnippet = bodyText ? truncateForLog(bodyText) : null;
  const diag = [
    `status=${status}`,
    statusText ? `statusText="${statusText}"` : null,
    remaining !== null ? `rate-limit-remaining=${remaining}` : null,
    reset !== null ? `rate-limit-reset=${reset}` : null,
    retryAfter !== null ? `retry-after=${retryAfter}` : null,
    sso !== null ? `x-github-sso="${sso}"` : null,
    apiMessage ? `message="${apiMessage}"` : null,
    bodySnippet ? `body=${bodySnippet}` : null,
  ].filter((part): part is string => part !== null).join(' ');
  logger.warn(`GitHub API request failed for ${label}: ${diag}`);

  if (status === 404) {
    throw new Error(`${label} not found. It may be private or deleted.`);
  }
  if (status === 401) {
    throw new Error(
      `GitHub authentication failed for ${label} (HTTP 401)` +
      `${apiMessage ? `: ${apiMessage}` : '.'}` +
      ' Sign in to GitHub in VS Code or refresh your credentials.',
    );
  }
  if (status === 403) {
    // Order matters: prefer the most specific signature so a coincidental
    // `remaining===0` doesn't mask SSO or secondary-rate-limit responses.
    if (sso) {
      throw new Error(
        `GitHub SSO authorization required for ${label}` +
        `${apiMessage ? `: ${apiMessage}` : '.'}` +
        ' Authorize the token for the organization, then retry.',
      );
    }
    if (isSecondaryRateLimited(retryAfter, apiMessage)) {
      const wait = formatRetryAfter(retryAfter);
      throw new Error(`GitHub secondary rate limit hit for ${label}.${wait ? ` ${wait}` : ''}`);
    }
    if (isPrimaryRateLimited(remaining, apiMessage)) {
      const resetHint = formatRateLimitReset(reset);
      throw new Error(
        `GitHub API rate limit exceeded for ${label}.` +
        `${resetHint ? ` ${resetHint}` : ''}` +
        ' Sign in to GitHub in VS Code for a higher quota.',
      );
    }
    throw new Error(
      `GitHub denied access to ${label} (HTTP 403)` +
      `${apiMessage ? `: ${apiMessage}` : '. The token may lack required permissions, or the resource may be private.'}`,
    );
  }
  throw new Error(
    `GitHub API error for ${label}: HTTP ${status}` +
    `${statusText ? ` ${statusText}` : ''}` +
    `${apiMessage ? ` — ${apiMessage}` : ''}`,
  );
}

async function safeReadResponseBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text ?? '';
  } catch {
    return '';
  }
}

function extractGitHubApiMessage(bodyText: string): string | undefined {
  if (!bodyText) { return undefined; }
  try {
    const parsed = JSON.parse(bodyText) as { message?: unknown };
    if (parsed && typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
      return parsed.message.trim();
    }
  } catch {
    // Body wasn't JSON — fall through.
  }
  return undefined;
}

function truncateForLog(text: string, limit = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) { return JSON.stringify(collapsed); }
  return JSON.stringify(collapsed.slice(0, limit) + '…');
}

function isPrimaryRateLimited(remaining: string | null, apiMessage: string | undefined): boolean {
  if (remaining === '0') { return true; }
  if (apiMessage && /api rate limit exceeded/i.test(apiMessage)) { return true; }
  return false;
}

function isSecondaryRateLimited(retryAfter: string | null, apiMessage: string | undefined): boolean {
  if (apiMessage && /secondary rate limit/i.test(apiMessage)) { return true; }
  if (!retryAfter) { return false; }
  // GitHub usually sends Retry-After with 403 only for abuse / secondary
  // rate-limit paths. The header may be either delta-seconds (RFC 7231) or
  // an HTTP-date; accept both forms.
  if (Number.isFinite(Number(retryAfter))) { return true; }
  if (!Number.isNaN(Date.parse(retryAfter))) { return true; }
  return false;
}

/**
 * Render a Retry-After header value as a short user-facing hint. Returns
 * undefined when the value is missing or unparseable. Numeric values are
 * shown as "Retry after Xs."; HTTP-date values are shown as a delta from
 * `Date.now()` when the date is in the future.
 */
function formatRetryAfter(retryAfter: string | null): string | undefined {
  if (!retryAfter) { return undefined; }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) { return `Retry after ${seconds}s.`; }
  const ts = Date.parse(retryAfter);
  if (Number.isNaN(ts)) { return undefined; }
  const delta = Math.max(0, Math.round((ts - Date.now()) / 1000));
  return delta > 0 ? `Retry after ${delta}s.` : 'Retry shortly.';
}

function formatRateLimitReset(reset: string | null): string | undefined {
  if (!reset) { return undefined; }
  const epochSeconds = Number(reset);
  if (!Number.isFinite(epochSeconds)) { return undefined; }
  const nowSeconds = Date.now() / 1000;
  const deltaSeconds = Math.max(0, Math.round(epochSeconds - nowSeconds));
  if (deltaSeconds === 0) { return 'Quota should reset momentarily.'; }
  if (deltaSeconds < 60) { return `Resets in ${deltaSeconds}s.`; }
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) { return `Resets in ${minutes} minute${minutes === 1 ? '' : 's'}.`; }
  const hours = Math.round(deltaSeconds / 3600);
  return `Resets in ${hours} hour${hours === 1 ? '' : 's'}.`;
}

/**
 * Header-only heuristic for whether a 403 response looks like a rate-limit
 * response (primary IP/user rate limit or secondary/abuse limit), based on
 * `x-ratelimit-remaining` and `Retry-After`. This is cheap to evaluate (no
 * body read) and is used to decide whether an unauthenticated `resolveUrl`
 * request should retry with interactive auth — prompting the user to sign in
 * only makes sense when the failure is plausibly fixed by getting a higher
 * authenticated quota.
 *
 * Returns false for non-403 responses.
 */
export function looksLikeRateLimited403(response: Response): boolean {
  if (response.status !== 403) { return false; }
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (remaining === '0') { return true; }
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    if (Number.isFinite(Number(retryAfter))) { return true; }
    if (!Number.isNaN(Date.parse(retryAfter))) { return true; }
  }
  return false;
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
        throw createAbortError();
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

  // Log rejected results so fetch/json failures aren't silently swallowed
  for (const r of results) {
    if (r.status === 'rejected') {
      logger.warn(`Worker failed during ${apiType} closed-item check: ${r.reason}`);
    }
  }

  // Filter out nulls and errors, keep only the closed IDs
  const isFulfilledNonNull = (
    r: PromiseSettledResult<string | null>,
  ): r is PromiseFulfilledResult<string> =>
    r.status === 'fulfilled' && r.value !== null;

  return results.filter(isFulfilledNonNull).map(r => r.value);
}
