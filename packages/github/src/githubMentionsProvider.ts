import * as vscode from 'vscode';
import { DiscoveredItem, combineSignals, runWorkerPoolSettled, safeDecodeComponent, type ResolvedItem } from '@devdocket/shared';
import { BaseGitHubProvider } from './baseGithubProvider';
import { logger } from './logger';
import { parseRepoFromUrls } from './parseRepo';
import { matchesRepoPatterns } from './repoPattern';
import { getHeaders, getGitHubAuthHeaders, retryWithAuth, throwApiError, parseCanonicalRepo, fetchClosedGitHubItems, buildIssueStateBadge, type GitHubIssue, type GitHubSearchResponse } from './githubApiHelpers';

const MENTIONS_ACTIVATED_KEY = 'mentionsActivatedAt';
const COMMENT_FETCH_CONCURRENCY = 3;
const COMMENT_PAGE_LIMIT = 10;

interface GitHubIssueComment {
  id: number;
  body?: string | null;
  updated_at?: string;
  created_at?: string;
}

/**
 * DevDocket provider that discovers GitHub issues and pull requests
 * where the current user is @mentioned.
 *
 * Uses the GitHub Search API with `mentions:@me` to find items.
 * On first activation, records a timestamp to avoid flooding the
 * inbox with historical mentions.
 */
export class GitHubMentionsProvider extends BaseGitHubProvider {
  readonly id = 'github-mentions';
  readonly label = 'GitHub Mentions';

  private readonly _context: vscode.ExtensionContext;
  private readonly mentionCommentCache = new Map<string, { issueUpdatedAt?: string; resurfaceVersion?: string }>();
  private mentionCommentCacheLogin?: string;
  private cachedLogin?: { accessToken: string; login: string };

  constructor(context: vscode.ExtensionContext) {
    super();
    this._context = context;
  }

  protected async fetchAndPublish(accessToken: string, isUserTriggered: boolean, signal?: AbortSignal): Promise<void> {
    logger.info('Fetching mentioned issues and PRs...');
    const activatedAt = await this.getOrSetActivatedAt(signal);
    const patterns = this.getConfiguredPatterns();
    const { results, failures } = await this.fetchAllMentions(accessToken, activatedAt, signal);

    const itemsWithRepo = results.map((issue) => ({
      issue,
      repoName: parseRepoFromUrls(issue.html_url, issue.repository_url),
    }));

    const filtered = patterns.length > 0
      ? itemsWithRepo.filter(({ repoName }) => matchesRepoPatterns(repoName, patterns))
      : itemsWithRepo;

    const activeExternalIds = new Set(filtered.map(({ issue, repoName }) => `${repoName}#${issue.number}`));
    if (failures.length === 0) {
      this.pruneMentionCommentCache(activeExternalIds);
    }

    const shouldComputeMentionVersions = filtered.some(({ issue }) => issue.comments_url || issue.body || issue.title);
    const currentLogin = shouldComputeMentionVersions ? await this.getCurrentLogin(accessToken, signal) : undefined;
    if (currentLogin && this.mentionCommentCacheLogin !== currentLogin) {
      this.mentionCommentCache.clear();
      this.mentionCommentCacheLogin = currentLogin;
    }
    // Search results are updated by any comment; only mentioning comments should trigger resurfacing.
    const resurfaceVersions = currentLogin
      ? await this.fetchMentionResurfaceVersions(filtered, accessToken, currentLogin, signal)
      : new Map<string, string>();

    const items: DiscoveredItem[] = filtered.map(({ issue, repoName }) => {
      const isPr = !!issue.pull_request;
      const externalId = `${repoName}#${issue.number}`;
      const resurfaceVersion = resurfaceVersions.get(externalId);
      return {
        externalId,
        title: `#${issue.number}: ${issue.title}`,
        description: issue.body ?? undefined,
        url: issue.html_url,
        group: repoName,
        reason: 'mentioned',
        canonicalId: `github:${isPr ? 'pull' : 'issue'}:${repoName}#${issue.number}`,
        itemType: isPr ? 'pr' : 'issue',
        badges: [
          { label: 'Mentioned', variant: 'warning' },
          ...buildIssueStateBadge(issue.state),
        ],
        ...(issue.state ? { state: issue.state } : {}),
        ...(resurfaceVersion ? { resurfaceVersion } : {}),
      };
    });

    logger.info(`Discovered ${items.length} mentioned items`);
    this._onDidDiscoverItems.fire(items);

    if (failures.length > 0) {
      const message = failures.length === 1
        ? `Failed to fetch mentions from ${failures[0]}`
        : `Failed to fetch mentions from ${failures.length} repositories`;
      if (isUserTriggered) {
        void vscode.window.showWarningMessage(`DevDocket GitHub: ${message}`);
      } else {
        logger.warn(message);
      }
    }
  }

  private static readonly GITHUB_ISSUE_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\b/i;
  private static readonly GITHUB_PR_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\b/i;

  async resolveUrl(url: string, signal?: AbortSignal): Promise<ResolvedItem | undefined> {
    const trimmed = url.trim();
    const issueMatch = trimmed.match(GitHubMentionsProvider.GITHUB_ISSUE_PATTERN);
    const prMatch = trimmed.match(GitHubMentionsProvider.GITHUB_PR_PATTERN);
    const match = issueMatch ?? prMatch;
    if (!match) { return undefined; }

    const [, rawOwner, rawRepo, numStr] = match;
    const owner = safeDecodeComponent(rawOwner);
    const repo = safeDecodeComponent(rawRepo);
    const number = parseInt(numStr, 10);
    const isPr = !!prMatch;

    const apiPath = isPr ? 'pulls' : 'issues';
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${apiPath}/${number}`;
    const headers = await getHeaders();
    const wasAuthenticated = 'Authorization' in headers;

    let response = await fetch(apiUrl, { headers, signal });

    if (response.status === 404 && !wasAuthenticated && !signal?.aborted) {
      const retryResponse = await retryWithAuth(apiUrl, signal);
      if (retryResponse) { response = retryResponse; }
    }

    if (!response.ok) {
      const label = isPr ? 'GitHub PR' : 'GitHub issue';
      throwApiError(response, `${label} ${owner}/${repo}#${number}`);
    }

    const data = await response.json() as { title: string; body: string | null; html_url: string };
    const canonicalRepo = parseCanonicalRepo(data.html_url, owner, repo);
    return {
      title: `#${number}: ${data.title}`,
      notes: data.body ?? '',
      url: data.html_url,
      externalId: `${canonicalRepo}#${number}`,
      group: canonicalRepo,
      providerId: this.id,
    };
  }

  /**
   * Check which of the given external IDs correspond to closed items.
   * GitHub's /issues/{N} endpoint returns data for both issues and PRs,
   * so a single call covers both types.
   */
  async getClosedItems(externalIds: string[], signal?: AbortSignal): Promise<string[]> {
    return fetchClosedGitHubItems(externalIds, 'issues', signal);
  }

  /**
   * Returns the activation timestamp, setting it on first call.
   * This prevents flooding the inbox with old mentions when the
   * provider is first enabled.
   *
   * If the current refresh has already been cancelled, do not persist
   * a new activation timestamp to avoid advancing the watermark
   * for a refresh that never completed.
   */
  private async getOrSetActivatedAt(signal?: AbortSignal): Promise<string> {
    const existing = this._context.globalState.get<string>(MENTIONS_ACTIVATED_KEY);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    if (signal?.aborted) {
      return now;
    }
    await this._context.globalState.update(MENTIONS_ACTIVATED_KEY, now);
    return now;
  }

  private async getCurrentLogin(token: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.cachedLogin?.accessToken === token) {
      return this.cachedLogin.login;
    }

    try {
      const response = await fetch('https://api.github.com/user', {
        headers: getGitHubAuthHeaders(token),
        signal: combineSignals(signal, 30_000),
      });
      if (response.ok) {
        const data = await response.json() as { login?: unknown };
        const login = typeof data.login === 'string' ? data.login.trim() : undefined;
        if (login && GitHubMentionsProvider.isValidGitHubLogin(login)) {
          this.cachedLogin = { accessToken: token, login };
          return login;
        }
      } else {
        logger.debug(`Failed to fetch GitHub user login: ${response.status}`);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) { throw err; }
      logger.debug('Could not fetch GitHub user login for mention comment filtering', err);
    }

    try {
      const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
      const label = session?.account?.label?.trim();
      if (label && GitHubMentionsProvider.isValidGitHubLogin(label)) {
        this.cachedLogin = { accessToken: token, login: label };
        return label;
      }
      logger.warn('Could not determine GitHub login for mention comment filtering');
      return undefined;
    } catch (err) {
      logger.warn('Could not determine fallback GitHub login for mention comment filtering', err);
      return undefined;
    }
  }

  private pruneMentionCommentCache(activeExternalIds: Set<string>): void {
    for (const externalId of this.mentionCommentCache.keys()) {
      if (!activeExternalIds.has(externalId)) {
        this.mentionCommentCache.delete(externalId);
      }
    }
  }

  private async fetchMentionResurfaceVersions(
    items: Array<{ issue: GitHubIssue; repoName: string }>,
    token: string,
    currentLogin: string,
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const results = await runWorkerPoolSettled(
      items,
      async ({ issue, repoName }) => {
        const externalId = `${repoName}#${issue.number}`;
        return {
          externalId,
          resurfaceVersion: await this.getMentionResurfaceVersion(issue, externalId, token, currentLogin, signal),
        };
      },
      COMMENT_FETCH_CONCURRENCY,
    );

    const versions = new Map<string, string>();
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.debug('Failed to inspect GitHub mention comments', result.reason);
        continue;
      }
      if (result.value.resurfaceVersion) {
        versions.set(result.value.externalId, result.value.resurfaceVersion);
      }
    }
    return versions;
  }

  private async getMentionResurfaceVersion(
    issue: GitHubIssue,
    externalId: string,
    token: string,
    currentLogin: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const bodyMentionVersion = GitHubMentionsProvider.getIssueBodyMentionVersion(issue, currentLogin);
    const cached = this.mentionCommentCache.get(externalId);
    if (cached && issue.updated_at && cached.issueUpdatedAt === issue.updated_at) {
      return cached.resurfaceVersion ?? bodyMentionVersion;
    }

    const previousCommentVersion = cached?.resurfaceVersion;
    const commentVersion = await this.fetchLatestMentionCommentVersion(issue, token, currentLogin, previousCommentVersion, signal);
    const resurfaceVersion = commentVersion ?? previousCommentVersion;
    this.mentionCommentCache.set(externalId, {
      issueUpdatedAt: issue.updated_at,
      resurfaceVersion,
    });
    return resurfaceVersion ?? bodyMentionVersion;
  }

  private async fetchLatestMentionCommentVersion(
    issue: GitHubIssue,
    token: string,
    currentLogin: string,
    previousCommentVersion?: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!issue.comments_url) {
      return undefined;
    }

    const since = GitHubMentionsProvider.getCommentVersionTimestamp(previousCommentVersion);
    const pageCount = since ? undefined : GitHubMentionsProvider.getCommentPageCount(issue.comments);
    let latestMention: { id: number; createdAt: string; time: number } | undefined;
    let lastPageWasFull = false;
    let scannedPages = 0;

    for (let index = 0; index < COMMENT_PAGE_LIMIT; index++) {
      const page = pageCount ? pageCount - index : index + 1;
      if (page < 1) {
        break;
      }

      let response: Response;
      try {
        response = await fetch(GitHubMentionsProvider.withCommentQuery(issue.comments_url, page, since, !!since), {
          headers: getGitHubAuthHeaders(token),
          signal: combineSignals(signal, 30_000),
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) { throw err; }
        logger.debug(`Failed to fetch comments for mention ${issue.html_url}`, err);
        return undefined;
      }

      if (!response.ok) {
        logger.debug(`Failed to fetch comments for mention ${issue.html_url}: ${response.status}`);
        return undefined;
      }

      scannedPages++;
      const comments = await response.json() as GitHubIssueComment[];
      lastPageWasFull = comments.length >= 100;
      for (const comment of comments) {
        if (!GitHubMentionsProvider.mentionsUser(comment.body, currentLogin)) {
          continue;
        }
        if (!comment.created_at) {
          continue;
        }
        const time = Date.parse(comment.created_at);
        if (Number.isNaN(time)) {
          continue;
        }
        if (!latestMention || time > latestMention.time) {
          latestMention = { id: comment.id, createdAt: comment.created_at, time };
        }
      }

      if (pageCount) {
        if (page === 1) {
          break;
        }
        if (comments.length === 0) {
          continue;
        }
      } else if (comments.length === 0 || comments.length < 100) {
        break;
      }
    }

    const moreForwardPages = !pageCount && lastPageWasFull;
    const moreBackwardPages = pageCount !== undefined && pageCount > scannedPages;
    if (scannedPages === COMMENT_PAGE_LIMIT && (moreForwardPages || moreBackwardPages)) {
      logger.warn(`Comment scan capped at ${COMMENT_PAGE_LIMIT} pages for ${issue.html_url}`);
    }

    return latestMention
      ? `comment:${latestMention.id}:${latestMention.createdAt}`
      : undefined;
  }

  private static getIssueBodyMentionVersion(issue: GitHubIssue, login: string): string | undefined {
    if (!GitHubMentionsProvider.mentionsUser(`${issue.title}\n${issue.body ?? ''}`, login)) {
      return undefined;
    }
    return `issue:${issue.number}`;
  }

  private static getCommentVersionTimestamp(version: string | undefined): string | undefined {
    const match = version?.match(/^comment:\d+:(.+)$/);
    return match?.[1];
  }

  private static getCommentPageCount(commentCount: number | undefined): number | undefined {
    if (commentCount === undefined || !Number.isFinite(commentCount) || commentCount <= 0) {
      return undefined;
    }
    return Math.ceil(commentCount / 100);
  }

  private static mentionsUser(body: string | null | undefined, login: string): boolean {
    if (!body) {
      return false;
    }
    const escapedLogin = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_-])@${escapedLogin}(?![A-Za-z0-9_-])`, 'i').test(body);
  }

  private static isValidGitHubLogin(login: string): boolean {
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login);
  }

  private static withCommentQuery(url: string, page: number, since?: string, newestFirst = false): string {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set('per_page', '100');
      parsed.searchParams.set('page', String(page));
      if (since) {
        parsed.searchParams.set('since', since);
      }
      if (newestFirst) {
        parsed.searchParams.set('sort', 'created');
        parsed.searchParams.set('direction', 'desc');
      }
      return parsed.toString();
    } catch {
      const separator = url.includes('?') ? '&' : '?';
      const sinceQuery = since ? `&since=${encodeURIComponent(since)}` : '';
      const orderQuery = newestFirst ? '&sort=created&direction=desc' : '';
      return `${url}${separator}per_page=100&page=${page}${sinceQuery}${orderQuery}`;
    }
  }

  private async fetchAllMentions(
    token: string,
    activatedAt: string,
    signal?: AbortSignal,
  ): Promise<{ results: GitHubIssue[]; failures: string[] }> {
    const q = `mentions:@me+updated:>${activatedAt}`;
    let response: Response;
    try {
      response = await fetch(
        `https://api.github.com/search/issues?q=${q}&per_page=100`,
        {
          headers: getGitHubAuthHeaders(token),
          signal: combineSignals(signal, 30_000),
        },
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) { throw err; }
      logger.error('Failed to fetch mentions', err);
      return { results: [], failures: ['all repositories'] };
    }

    if (!response.ok) {
      logger.error(`Failed to fetch mentions: ${response.status}`);
      return { results: [], failures: ['all repositories'] };
    }

    const data = (await response.json()) as GitHubSearchResponse;
    return { results: data.items, failures: [] };
  }
}
