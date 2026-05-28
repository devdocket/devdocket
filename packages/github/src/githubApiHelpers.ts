import * as vscode from 'vscode';
import {
  isSafeUrl,
  isValidGitHubRepo,
  combineSignals,
  createAbortError,
  getSessionWithAuthFallback,
  parseRateLimitResetHeader,
  parseRetryAfterHeader,
  PollingBackoffError,
  runWorkerPoolSettled,
  type ProviderBadge,
  type RecoverableError,
  type RecoverableErrorAction,
} from '@devdocket/shared';
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

const AUTHORIZE_IN_BROWSER = 'Authorize in browser';
const GITHUB_API_BACKOFF_KEY = 'api.github.com';

interface GitHubSsoErrorOptions {
  ssoUrl?: string;
  orgName?: string;
}

export class GitHubSsoError extends Error implements RecoverableError {
  readonly recoverable = true as const;
  readonly retryable = true as const;
  readonly ssoUrl: string | undefined;
  readonly orgName: string | undefined;
  readonly actions?: ReadonlyArray<RecoverableErrorAction>;

  constructor(opts?: GitHubSsoErrorOptions);
  constructor(message: string, opts?: GitHubSsoErrorOptions);
  constructor(messageOrOpts: string | GitHubSsoErrorOptions = {}, opts: GitHubSsoErrorOptions = {}) {
    const resolvedOptions = typeof messageOrOpts === 'string' ? opts : messageOrOpts;
    const authorizationUrl = getGitHubSsoAuthorizationUrl(resolvedOptions);
    const safeAuthorizationUrl = authorizationUrl ? isSafeUrl(authorizationUrl) : null;
    const trustedAuthorizationUrl = safeAuthorizationUrl && isTrustedGitHubSsoUrl(safeAuthorizationUrl)
      ? safeAuthorizationUrl
      : null;
    super(typeof messageOrOpts === 'string' ? messageOrOpts : buildGitHubSsoMessage(resolvedOptions.orgName));
    this.name = 'GitHubSsoError';
    this.ssoUrl = trustedAuthorizationUrl?.href;
    this.orgName = resolvedOptions.orgName;
    this.actions = trustedAuthorizationUrl
      ? [createAuthorizeInBrowserAction(trustedAuthorizationUrl.href)]
      : undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function buildGitHubSsoMessage(orgName?: string): string {
  const orgLabel = orgName
    ? `the "${orgName}" organization`
    : 'this organization';
  return `DevDocket: GitHub requires SSO authorization for ${orgLabel}\nbefore this item can be loaded.`;
}

function getGitHubSsoAuthorizationUrl(opts: GitHubSsoErrorOptions): string | undefined {
  if (opts.ssoUrl) {
    return opts.ssoUrl;
  }
  if (opts.orgName) {
    return `https://github.com/orgs/${encodeURIComponent(opts.orgName)}/sso`;
  }
  return undefined;
}

function createAuthorizeInBrowserAction(authorizationUrl: string): RecoverableErrorAction {
  return {
    label: AUTHORIZE_IN_BROWSER,
    retryAfterAction: true,
    run: async () => {
      await vscode.env.openExternal(vscode.Uri.parse(authorizationUrl));
    },
  };
}

function isTrustedGitHubSsoUrl(url: URL): boolean {
  return url.hostname === 'github.com';
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
  const session = await getGitHubSession(['repo'], { ...options, signal });
  if (!session) {
    return undefined;
  }

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

  const remaining = response.headers?.get?.('x-ratelimit-remaining') ?? null;
  const reset = response.headers?.get?.('x-ratelimit-reset') ?? null;
  const retryAfter = response.headers?.get?.('retry-after') ?? null;
  const sso = response.headers?.get?.('x-github-sso') ?? null;
  const retryAfterMs = parseRetryAfterHeader(retryAfter);
  const rateLimitResetAtMs = parseRateLimitResetHeader(reset);
  const resetDelayMs = rateLimitResetAtMs !== undefined
    ? Math.max(0, rateLimitResetAtMs - Date.now())
    : undefined;
  const enforcedRetryAfterMs = Math.max(retryAfterMs ?? 0, resetDelayMs ?? 0) || undefined;

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
      const { ssoUrl, orgName } = parseGitHubSsoInfo(sso);
      throw new GitHubSsoError({ ssoUrl, orgName });
    }
    if (isSecondaryRateLimited(retryAfter, apiMessage)) {
      const wait = formatRetryAfter(retryAfter);
      throw new PollingBackoffError({
        message: `GitHub secondary rate limit hit for ${label}.${wait ? ` ${wait}` : ''}`,
        backoffKey: GITHUB_API_BACKOFF_KEY,
        statusCode: status,
        retryAfterMs: enforcedRetryAfterMs,
      });
    }
    if (isPrimaryRateLimited(remaining, apiMessage)) {
      const resetHint = formatRateLimitReset(reset);
      throw new PollingBackoffError({
        message: `GitHub API rate limit exceeded for ${label}.`
          + `${resetHint ? ` ${resetHint}` : ''}`
          + ' Sign in to GitHub in VS Code for a higher quota.',
        backoffKey: GITHUB_API_BACKOFF_KEY,
        statusCode: status,
        retryAfterMs: enforcedRetryAfterMs,
      });
    }
    throw new Error(
      `GitHub denied access to ${label} (HTTP 403)` +
      `${apiMessage ? `: ${apiMessage}` : '. The token may lack required permissions, or the resource may be private.'}`,
    );
  }
  if (status === 429) {
    const wait = formatRetryAfter(retryAfter);
    throw new PollingBackoffError({
      message: `GitHub rate limit hit for ${label}.${wait ? ` ${wait}` : ''}`,
      backoffKey: GITHUB_API_BACKOFF_KEY,
      statusCode: status,
      retryAfterMs: enforcedRetryAfterMs,
    });
  }
  if (status === 503) {
    const wait = formatRetryAfter(retryAfter);
    throw new PollingBackoffError({
      message: `GitHub API temporarily unavailable for ${label}.${wait ? ` ${wait}` : ''}`,
      backoffKey: GITHUB_API_BACKOFF_KEY,
      statusCode: status,
      retryAfterMs: enforcedRetryAfterMs,
    });
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

function parseGitHubSsoInfo(headerValue: string | null): { ssoUrl?: string; orgName?: string } {
  if (!headerValue) {
    return {};
  }

  const ssoUrl = headerValue
    .split(';')
    .map(part => part.trim())
    .find(part => part.toLowerCase().startsWith('url='))
    ?.slice(4)
    .trim();

  if (!ssoUrl) {
    return {};
  }

  try {
    const parsed = new URL(ssoUrl);
    const match = parsed.pathname.match(/^\/orgs\/([^/]+)\/sso\/?$/i);
    return {
      ssoUrl,
      orgName: match?.[1] ? decodeURIComponent(match[1]) : undefined,
    };
  } catch {
    return { ssoUrl };
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

interface ParsedClosedGitHubItem {
  id: string;
  owner: string;
  repoName: string;
  number: number;
}

interface ClosedGitHubGraphQLError {
  message?: string;
  path?: unknown[];
  type?: string;
  extensions?: { code?: unknown };
}

interface ClosedGitHubGraphQLPayload {
  data?: {
    repository?: Record<string, { state?: string | null } | null | undefined> | null;
  };
  errors?: ClosedGitHubGraphQLError[];
}

const CLOSED_ITEM_GRAPHQL_ALIAS_LIMIT = 50;

/**
 * Shared implementation for getClosedItems across GitHub providers.
 * Parses external IDs ("owner/repo#number"), validates repo slugs, and
 * batches item state checks through GitHub GraphQL with REST fallback.
 *
 * @param externalIds - External IDs in "owner/repo#number" format.
 * @param apiType - GitHub item type: `'issues'` checks issue-like IDs, `'pulls'` checks PRs.
 * @param signal - Optional abort signal for cancellation.
 * @returns External IDs whose GitHub state is closed or merged.
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

  const parsed = parseClosedGitHubExternalIds(externalIds);
  if (parsed.length === 0) { return []; }

  const chunks = createClosedGitHubGraphQLChunks(parsed, apiType);
  const results = await runWorkerPoolSettled(
    chunks,
    chunk => fetchClosedGitHubItemsGraphQLWithRestFallback(session!.accessToken, chunk, apiType, signal),
    5,
  );

  const closedIds: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      closedIds.push(...result.value);
      continue;
    }
    if (isAbortError(result.reason) && signal?.aborted) { throw result.reason; }
    if (result.reason instanceof PollingBackoffError) { throw result.reason; }
    logger.warn(`Failed during ${apiType} closed-item batch check: ${String(result.reason)}`);
  }

  return closedIds;
}

function parseClosedGitHubExternalIds(externalIds: string[]): ParsedClosedGitHubItem[] {
  const seen = new Set<string>();
  const parsed: ParsedClosedGitHubItem[] = [];

  for (const id of externalIds) {
    if (seen.has(id)) { continue; }
    const hashIdx = id.lastIndexOf('#');
    if (hashIdx === -1) { continue; }
    const rawRepo = id.substring(0, hashIdx);
    const rawNumber = id.substring(hashIdx + 1);
    if (!/^\d+$/.test(rawNumber) || !isValidGitHubRepo(rawRepo)) { continue; }
    const number = Number(rawNumber);
    const [owner, repoName] = rawRepo.split('/');
    seen.add(id);
    parsed.push({ id, owner, repoName, number });
  }

  return parsed;
}

function createClosedGitHubGraphQLChunks(
  items: ParsedClosedGitHubItem[],
  apiType: 'issues' | 'pulls',
): ParsedClosedGitHubItem[][] {
  const byRepo = new Map<string, ParsedClosedGitHubItem[]>();
  for (const item of items) {
    const repoKey = `${item.owner}/${item.repoName}`;
    const repoItems = byRepo.get(repoKey) ?? [];
    repoItems.push(item);
    byRepo.set(repoKey, repoItems);
  }

  const fieldsPerItem = apiType === 'issues' ? 2 : 1;
  const maxItemsPerQuery = Math.max(1, Math.floor(CLOSED_ITEM_GRAPHQL_ALIAS_LIMIT / fieldsPerItem));
  const chunks: ParsedClosedGitHubItem[][] = [];
  for (const repoItems of byRepo.values()) {
    for (let i = 0; i < repoItems.length; i += maxItemsPerQuery) {
      chunks.push(repoItems.slice(i, i + maxItemsPerQuery));
    }
  }
  return chunks;
}

async function fetchClosedGitHubItemsGraphQLWithRestFallback(
  token: string,
  items: ParsedClosedGitHubItem[],
  apiType: 'issues' | 'pulls',
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    return await fetchClosedGitHubItemsGraphQLChunk(token, items, apiType, signal);
  } catch (error) {
    if (isAbortError(error) || error instanceof PollingBackoffError) { throw error; }
    if (error instanceof GitHubSsoError) {
      logger.debug(`Skipping ${apiType} closed-item GraphQL chunk after SSO error: ${error.message}`);
      return [];
    }
    logger.debug(`GraphQL ${apiType} closed-item check failed; falling back to REST: ${String(error)}`);
    return fetchClosedGitHubItemsRest(token, items, apiType, signal);
  }
}

async function fetchClosedGitHubItemsGraphQLChunk(
  token: string,
  items: ParsedClosedGitHubItem[],
  apiType: 'issues' | 'pulls',
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) { throw createAbortError(); }
  const request = buildClosedGitHubItemsGraphQLRequest(items, apiType);
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      ...getGitHubAuthHeaders(token),
      'Content-Type': 'application/json',
      'User-Agent': 'DevDocket-VSCode',
    },
    body: JSON.stringify(request),
    signal: combineSignals(signal, 30_000),
  });

  if (!response.ok) {
    await throwApiError(response, `${apiType} closed-item GraphQL batch`);
  }

  const payload = await response.json() as ClosedGitHubGraphQLPayload;
  if (payload.errors?.length) {
    throwClosedGitHubGraphQLBackoffErrorIfNeeded(payload.errors, response, `${apiType} closed-item GraphQL batch`);
  }
  if (payload.errors?.length && !payload.data) {
    throw new Error(`GitHub GraphQL closed-item batch failed: ${formatGraphQLErrorMessages(payload.errors)}`);
  }
  if (payload.errors?.length) {
    logger.warn(`GitHub GraphQL closed-item batch returned partial errors: ${formatGraphQLErrorMessages(payload.errors)}`);
  }

  const repository = payload.data?.repository;
  if (!repository) { return []; }

  const closedIds: string[] = [];
  items.forEach((item, index) => {
    if (apiType === 'pulls') {
      if (isClosedGraphQLState(repository[getPullRequestAlias(index)]?.state)) {
        closedIds.push(item.id);
      }
      return;
    }

    const issueState = repository[getIssueAlias(index)]?.state;
    const pullRequestState = repository[getPullRequestAlias(index)]?.state;
    if (isClosedGraphQLState(issueState) || isClosedGraphQLState(pullRequestState)) {
      closedIds.push(item.id);
    }
  });

  return closedIds;
}

function buildClosedGitHubItemsGraphQLRequest(
  items: ParsedClosedGitHubItem[],
  apiType: 'issues' | 'pulls',
): { query: string; variables: { owner: string; name: string } } {
  const [first] = items;
  const selections: string[] = [];
  items.forEach((item, index) => {
    if (apiType === 'issues') {
      selections.push(`${getIssueAlias(index)}: issue(number: ${item.number}) { state }`);
    }
    selections.push(`${getPullRequestAlias(index)}: pullRequest(number: ${item.number}) { state }`);
  });

  return {
    query: `query ClosedGitHubItems($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n    ${selections.join('\n    ')}\n  }\n}`,
    variables: { owner: first.owner, name: first.repoName },
  };
}

async function fetchClosedGitHubItemsRest(
  token: string,
  items: ParsedClosedGitHubItem[],
  apiType: 'issues' | 'pulls',
  signal?: AbortSignal,
): Promise<string[]> {
  const closedIds: string[] = [];
  for (const item of items) {
    try {
      const closedId = await fetchClosedGitHubItemRest(token, item, apiType, signal);
      if (closedId) { closedIds.push(closedId); }
    } catch (error) {
      if (isAbortError(error) || error instanceof PollingBackoffError) { throw error; }
      if (error instanceof GitHubSsoError) {
        logger.debug(`Skipping ${apiType} ${item.id} REST closed-item check after SSO error: ${error.message}`);
        continue;
      }
      logger.debug(`Worker failed during ${apiType} REST closed-item check: ${String(error)}`);
    }
  }
  return closedIds;
}

async function fetchClosedGitHubItemRest(
  token: string,
  item: ParsedClosedGitHubItem,
  apiType: 'issues' | 'pulls',
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) { throw createAbortError(); }
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repoName)}/${apiType}/${item.number}`,
    {
      headers: {
        ...getGitHubAuthHeaders(token),
        'User-Agent': 'DevDocket-VSCode',
      },
      signal: combineSignals(signal, 30_000),
    },
  );
  if (!response.ok) {
    const sso = response.headers?.get?.('x-github-sso') ?? null;
    if (response.status === 403 && sso) {
      const { ssoUrl, orgName } = parseGitHubSsoInfo(sso);
      throw new GitHubSsoError({ ssoUrl, orgName });
    }
    if (response.status === 403 || response.status === 429 || response.status === 503) {
      await throwApiError(response, `GitHub ${apiType} ${item.id}`);
    }
    logger.debug(`Failed to check ${apiType} ${item.id}: ${response.status}`);
    return null;
  }
  const data = await response.json() as { state?: string };
  return data.state?.toLowerCase() === 'closed' ? item.id : null;
}

function throwClosedGitHubGraphQLBackoffErrorIfNeeded(
  errors: ClosedGitHubGraphQLError[],
  response: Response,
  label: string,
): void {
  const sso = response.headers?.get?.('x-github-sso') ?? null;
  if (sso && errors.some(isGraphQLForbiddenError)) {
    const { ssoUrl, orgName } = parseGitHubSsoInfo(sso);
    throw new GitHubSsoError({ ssoUrl, orgName });
  }

  const rateLimitError = errors.find(isGraphQLRateLimitError);
  if (!rateLimitError) { return; }

  const retryAfter = response.headers?.get?.('retry-after') ?? null;
  const reset = response.headers?.get?.('x-ratelimit-reset') ?? null;
  const retryAfterMs = parseRetryAfterHeader(retryAfter);
  const rateLimitResetAtMs = parseRateLimitResetHeader(reset);
  const resetDelayMs = rateLimitResetAtMs !== undefined
    ? Math.max(0, rateLimitResetAtMs - Date.now())
    : undefined;
  const enforcedRetryAfterMs = Math.max(retryAfterMs ?? 0, resetDelayMs ?? 0) || undefined;
  const wait = formatRetryAfter(retryAfter) ?? formatRateLimitReset(reset);
  const message = rateLimitError.message ?? '';
  const isSecondary = /secondary rate limit/i.test(message);

  throw new PollingBackoffError({
    message: isSecondary
      ? `GitHub secondary rate limit hit for ${label}.${wait ? ` ${wait}` : ''}`
      : `GitHub GraphQL rate limit exceeded for ${label}.${wait ? ` ${wait}` : ''}`,
    backoffKey: GITHUB_API_BACKOFF_KEY,
    statusCode: 200,
    retryAfterMs: enforcedRetryAfterMs,
  });
}

function isGraphQLForbiddenError(error: ClosedGitHubGraphQLError): boolean {
  const type = error.type?.toUpperCase();
  const code = typeof error.extensions?.code === 'string' ? error.extensions.code.toUpperCase() : undefined;
  const message = error.message ?? '';
  return type === 'FORBIDDEN' || code === 'FORBIDDEN' || /saml|sso|resource protected/i.test(message);
}

function isGraphQLRateLimitError(error: ClosedGitHubGraphQLError): boolean {
  const type = error.type?.toUpperCase();
  const code = typeof error.extensions?.code === 'string' ? error.extensions.code.toUpperCase() : undefined;
  const message = error.message ?? '';
  return type === 'RATE_LIMITED'
    || code === 'RATE_LIMITED'
    || code === 'RATE_LIMIT'
    || /rate limit/i.test(message);
}

function getIssueAlias(index: number): string {
  return `i${index}`;
}

function getPullRequestAlias(index: number): string {
  return `pr${index}`;
}

function isClosedGraphQLState(state: string | null | undefined): boolean {
  const normalized = state?.toUpperCase();
  return normalized === 'CLOSED' || normalized === 'MERGED';
}

function formatGraphQLErrorMessages(errors: ClosedGitHubGraphQLError[]): string {
  return errors.map(error => error.message).filter(Boolean).join('; ') || 'Unknown GraphQL error';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
