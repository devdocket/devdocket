import * as vscode from 'vscode';
import { Lexer, type Token, type Tokens } from 'marked';
import { DiscoveredItem, combineSignals, runWorkerPoolSettled, safeDecodeComponent, type ResolvedItem } from '@devdocket/shared';
import { BaseGitHubProvider } from './baseGithubProvider';
import { logger } from './logger';
import { parseRepoFromUrls } from './parseRepo';
import { matchesRepoPatterns } from './repoPattern';
import { getHeaders, getGitHubAuthHeaders, retryWithAuth, throwApiError, parseCanonicalRepo, fetchClosedGitHubItems, buildIssueStateBadge, type GitHubIssue, type GitHubSearchResponse } from './githubApiHelpers';

const MENTIONS_ACTIVATED_KEY = 'mentionsActivatedAt';
const COMMENT_FETCH_CONCURRENCY = 3;
const COMMENT_PAGE_LIMIT = 10;
const TEAM_MENTION_CACHE_TTL_MS = 30 * 60 * 1000;

interface GitHubIssueComment {
  id: number;
  body?: string | null;
  updated_at?: string;
  created_at?: string;
}

interface GitHubTeamMembership {
  slug?: unknown;
  organization?: {
    login?: unknown;
  } | null;
}

type TeamMentionFetchResult =
  | { ok: true; teams: Set<string> }
  | { ok: false; teams: Set<string> };

type MentionCommentFetchResult = {
  resurfaceVersion?: string;
  latestScannedAt?: string;
  scanCapped: boolean;
};

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

  private static readonly AUTH_SCOPES = ['repo', 'read:org'];

  private readonly _context: vscode.ExtensionContext;
  private readonly mentionCommentCache = new Map<string, { issueUpdatedAt?: string; resurfaceVersion?: string; commentScanSince?: string }>();
  private mentionCommentCacheLogin?: string;
  private cachedLogin?: { accessToken: string; login: string };
  private teamMentionCache?: { accessToken: string; login: string; expiresAtMs: number; teams: Set<string> };

  constructor(context: vscode.ExtensionContext) {
    super();
    this._context = context;
  }

  protected override getAuthenticationScopes(): string[] {
    return GitHubMentionsProvider.AUTH_SCOPES;
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

    const currentLogin = filtered.length > 0 ? await this.getCurrentLogin(accessToken, signal) : undefined;
    let teamMentions = new Set<string>();
    if (currentLogin) {
      if (this.mentionCommentCacheLogin !== currentLogin) {
        this.mentionCommentCache.clear();
        this.teamMentionCache = undefined;
        this.mentionCommentCacheLogin = currentLogin;
      }
      teamMentions = await this.getCurrentUserTeamMentions(accessToken, currentLogin, signal);
    }
    // Search results are updated by any comment; only mentioning comments should trigger resurfacing.
    const resurfaceVersions = currentLogin
      ? await this.fetchMentionResurfaceVersions(filtered, accessToken, currentLogin, teamMentions, signal)
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
      const session = await vscode.authentication.getSession('github', GitHubMentionsProvider.AUTH_SCOPES, { createIfNone: false });
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

  private async getCurrentUserTeamMentions(token: string, login: string, signal?: AbortSignal): Promise<Set<string>> {
    const now = Date.now();
    const cached = this.teamMentionCache;
    if (cached && cached.accessToken === token && cached.login === login && cached.expiresAtMs > now) {
      return cached.teams;
    }

    const result = await this.fetchCurrentUserTeamMentions(token, signal);
    if (result.ok) {
      this.teamMentionCache = {
        accessToken: token,
        login,
        expiresAtMs: now + TEAM_MENTION_CACHE_TTL_MS,
        teams: result.teams,
      };
    }
    return result.teams;
  }

  private async fetchCurrentUserTeamMentions(token: string, signal?: AbortSignal): Promise<TeamMentionFetchResult> {
    const teams = new Set<string>();

    for (let page = 1; ; page++) {
      let response: Response | undefined;
      try {
        response = await fetch(`https://api.github.com/user/teams?per_page=100&page=${page}`, {
          headers: getGitHubAuthHeaders(token),
          signal: combineSignals(signal, 30_000),
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) { throw err; }
        logger.warn('Could not fetch GitHub team memberships for mention filtering', err);
        return { ok: false, teams };
      }

      if (!response?.ok) {
        logger.warn(`Could not fetch GitHub team memberships for mention filtering: ${response?.status ?? 'no response'}`);
        return { ok: false, teams };
      }

      let data: GitHubTeamMembership[];
      try {
        data = await response.json() as GitHubTeamMembership[];
      } catch (err) {
        logger.warn('Could not parse GitHub team memberships for mention filtering', err);
        return { ok: false, teams };
      }
      if (!Array.isArray(data)) {
        logger.warn('Could not parse GitHub team memberships for mention filtering');
        return { ok: false, teams };
      }

      for (const team of data) {
        const orgLogin = typeof team.organization?.login === 'string' ? team.organization.login.trim() : '';
        const teamSlug = typeof team.slug === 'string' ? team.slug.trim() : '';
        if (!GitHubMentionsProvider.isValidGitHubLogin(orgLogin) || !GitHubMentionsProvider.isValidTeamSlug(teamSlug)) {
          continue;
        }
        teams.add(GitHubMentionsProvider.normalizeTeamMention(orgLogin, teamSlug));
      }

      if (data.length < 100) {
        return { ok: true, teams };
      }
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
    teamMentions: Set<string>,
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const results = await runWorkerPoolSettled(
      items,
      async ({ issue, repoName }) => {
        const externalId = `${repoName}#${issue.number}`;
        return {
          externalId,
          resurfaceVersion: await this.getMentionResurfaceVersion(issue, externalId, token, currentLogin, teamMentions, signal),
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
    teamMentions: Set<string>,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const bodyMentionVersion = GitHubMentionsProvider.getIssueBodyMentionVersion(issue, currentLogin, teamMentions);
    const cached = this.mentionCommentCache.get(externalId);
    if (cached && issue.updated_at && cached.issueUpdatedAt === issue.updated_at) {
      return cached.resurfaceVersion ?? bodyMentionVersion;
    }

    const previousResurfaceVersion = cached?.resurfaceVersion;
    const previousCommentSince = cached?.commentScanSince ?? GitHubMentionsProvider.getCommentVersionTimestamp(previousResurfaceVersion);
    const commentResult = await this.fetchLatestMentionCommentVersion(issue, token, currentLogin, teamMentions, previousCommentSince, signal);
    const resurfaceVersion = commentResult.resurfaceVersion
      ?? previousResurfaceVersion
      ?? bodyMentionVersion
      ?? (commentResult.scanCapped ? GitHubMentionsProvider.getCappedCommentScanVersion(issue) : undefined);
    const commentScanSince = commentResult.latestScannedAt
      ?? GitHubMentionsProvider.getCommentVersionTimestamp(resurfaceVersion)
      ?? previousCommentSince;
    this.mentionCommentCache.set(externalId, {
      issueUpdatedAt: issue.updated_at,
      resurfaceVersion,
      commentScanSince,
    });
    return resurfaceVersion;
  }

  private async fetchLatestMentionCommentVersion(
    issue: GitHubIssue,
    token: string,
    currentLogin: string,
    teamMentions: Set<string>,
    previousCommentSince?: string,
    signal?: AbortSignal,
  ): Promise<MentionCommentFetchResult> {
    if (!issue.comments_url || issue.comments === 0) {
      return { scanCapped: false };
    }

    const since = previousCommentSince;
    const pageCount = since ? undefined : GitHubMentionsProvider.getCommentPageCount(issue.comments);
    const newestFirst = !!since || pageCount === undefined;
    let latestMention: { id: number; createdAt: string; time: number } | undefined;
    let latestScannedComment: { createdAt: string; time: number } | undefined;
    let lastPageWasFull = false;
    let scannedPages = 0;

    for (let index = 0; index < COMMENT_PAGE_LIMIT; index++) {
      const page = pageCount ? pageCount - index : index + 1;
      if (page < 1) {
        break;
      }

      let response: Response;
      try {
        response = await fetch(GitHubMentionsProvider.withCommentQuery(issue.comments_url, page, since, newestFirst), {
          headers: getGitHubAuthHeaders(token),
          signal: combineSignals(signal, 30_000),
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) { throw err; }
        logger.debug(`Failed to fetch comments for mention ${issue.html_url}`, err);
        return { scanCapped: false };
      }

      if (!response.ok) {
        logger.debug(`Failed to fetch comments for mention ${issue.html_url}: ${response.status}`);
        return { scanCapped: false };
      }

      scannedPages++;
      const comments = await response.json() as GitHubIssueComment[];
      lastPageWasFull = comments.length >= 100;
      for (const comment of comments) {
        const createdAt = comment.created_at;
        const time = createdAt ? Date.parse(createdAt) : Number.NaN;
        if (createdAt && !Number.isNaN(time) && (!latestScannedComment || time > latestScannedComment.time)) {
          latestScannedComment = { createdAt, time };
        }
        if (!GitHubMentionsProvider.mentionsUser(comment.body, currentLogin, teamMentions)) {
          continue;
        }
        if (!createdAt || Number.isNaN(time)) {
          continue;
        }
        if (!latestMention || time > latestMention.time) {
          latestMention = { id: comment.id, createdAt, time };
        }
      }

      if (latestMention && (newestFirst || pageCount)) {
        break;
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
    const scanCapped = !latestMention && scannedPages === COMMENT_PAGE_LIMIT && (moreForwardPages || moreBackwardPages);
    if (scanCapped) {
      logger.warn(`Comment scan capped at ${COMMENT_PAGE_LIMIT} pages for ${issue.html_url}`);
    }

    return {
      resurfaceVersion: latestMention ? `comment:${latestMention.id}:${latestMention.createdAt}` : undefined,
      latestScannedAt: latestScannedComment?.createdAt,
      scanCapped,
    };
  }

  private static getCappedCommentScanVersion(issue: GitHubIssue): string {
    return `comments-capped:${issue.number}`;
  }

  private static getIssueBodyMentionVersion(issue: GitHubIssue, login: string, teamMentions: Set<string>): string | undefined {
    if (!GitHubMentionsProvider.mentionsUser(`${issue.title}\n${issue.body ?? ''}`, login, teamMentions)) {
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

  private static mentionsUser(body: string | null | undefined, login: string, teamMentions: Set<string>): boolean {
    if (!body) {
      return false;
    }

    let tokens: Token[];
    try {
      tokens = Lexer.lex(body);
    } catch (err) {
      logger.debug('Could not parse GitHub markdown for mention filtering', err);
      return false;
    }

    for (const text of GitHubMentionsProvider.markdownTextSegments(tokens)) {
      if (GitHubMentionsProvider.textMentionsUser(text, login, teamMentions)) {
        return true;
      }
    }
    return false;
  }

  private static *markdownTextSegments(tokens: readonly Token[]): Generator<string> {
    for (const token of tokens) {
      yield* GitHubMentionsProvider.tokenTextSegments(token);
    }
  }

  private static *tokenTextSegments(token: Token): Generator<string> {
    switch (token.type) {
      case 'code':
      case 'codespan':
      case 'def':
      case 'html':
      case 'image':
        return;
      case 'escape':
        return;
      case 'link': {
        const linkToken = GitHubMentionsProvider.asLinkToken(token);
        if (!linkToken || GitHubMentionsProvider.isAutolinkToken(linkToken)) {
          return;
        }
        yield* GitHubMentionsProvider.markdownTextSegments(linkToken.tokens);
        return;
      }
      case 'text':
        if (token.tokens?.length) {
          yield* GitHubMentionsProvider.markdownTextSegments(token.tokens);
        } else {
          yield token.text;
        }
        return;
      case 'list':
        for (const item of token.items) {
          yield* GitHubMentionsProvider.tokenTextSegments(item);
        }
        return;
      case 'table':
        for (const cell of token.header) {
          yield* GitHubMentionsProvider.markdownTextSegments(cell.tokens);
        }
        for (const row of token.rows) {
          for (const cell of row) {
            yield* GitHubMentionsProvider.markdownTextSegments(cell.tokens);
          }
        }
        return;
      default: {
        const nested = (token as Tokens.Generic).tokens;
        if (nested?.length) {
          yield* GitHubMentionsProvider.markdownTextSegments(nested);
        }
      }
    }
  }

  private static asLinkToken(token: Token): Tokens.Link | undefined {
    const candidate = token as Partial<Tokens.Link>;
    if (typeof candidate.href !== 'string' || !Array.isArray(candidate.tokens)) {
      return undefined;
    }
    return candidate as Tokens.Link;
  }

  private static isAutolinkToken(token: Tokens.Link): boolean {
    return token.raw === token.href || token.raw === `<${token.href}>`;
  }

  private static readonly MENTION_PATTERN = /(^|[^A-Za-z0-9_])@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?:\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,253}[A-Za-z0-9])?))?(?![A-Za-z0-9-/])/gi;

  private static textMentionsUser(text: string, login: string, teamMentions: Set<string>): boolean {
    const normalizedLogin = login.toLowerCase();
    GitHubMentionsProvider.MENTION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = GitHubMentionsProvider.MENTION_PATTERN.exec(text)) !== null) {
      const [, , userOrOrg, teamSlug] = match;
      if (teamSlug) {
        if (teamMentions.has(GitHubMentionsProvider.normalizeTeamMention(userOrOrg, teamSlug))) {
          return true;
        }
        continue;
      }

      if (GitHubMentionsProvider.isValidGitHubLogin(userOrOrg) && userOrOrg.toLowerCase() === normalizedLogin) {
        return true;
      }
    }
    return false;
  }

  private static normalizeTeamMention(orgLogin: string, teamSlug: string): string {
    return `${orgLogin.toLowerCase()}/${teamSlug.toLowerCase()}`;
  }

  private static isValidGitHubLogin(login: string): boolean {
    return /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login);
  }

  private static isValidTeamSlug(slug: string): boolean {
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,253}[A-Za-z0-9])?$/.test(slug);
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
