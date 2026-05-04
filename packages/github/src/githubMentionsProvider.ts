import * as vscode from 'vscode';
import { DiscoveredItem, combineSignals, runWorkerPoolSettled, safeDecodeComponent, type ResolvedItem } from '@devdocket/shared';
import { BaseGitHubProvider } from './baseGithubProvider';
import { logger } from './logger';
import { parseRepoFromUrls } from './parseRepo';
import { matchesRepoPatterns } from './repoPattern';
import { getHeaders, getGitHubAuthHeaders, retryWithAuth, throwApiError, parseCanonicalRepo, fetchClosedGitHubItems, buildIssueStateBadge, type GitHubIssue, type GitHubSearchResponse } from './githubApiHelpers';

const MENTIONS_ACTIVATED_KEY = 'mentionsActivatedAt';
const COMMENT_FETCH_CONCURRENCY = 3;

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

    const shouldInspectComments = filtered.some(({ issue }) => !!issue.comments_url);
    const currentLogin = shouldInspectComments ? await this.getCurrentLogin(accessToken, signal) : undefined;
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
    try {
      const response = await fetch('https://api.github.com/user', {
        headers: getGitHubAuthHeaders(token),
        signal: combineSignals(signal, 30_000),
      });
      if (response.ok) {
        const data = await response.json() as { login?: unknown };
        const login = typeof data.login === 'string' ? data.login.trim() : undefined;
        if (login && GitHubMentionsProvider.isValidGitHubLogin(login)) {
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
      return label && GitHubMentionsProvider.isValidGitHubLogin(label) ? label : undefined;
    } catch (err) {
      logger.debug('Could not determine fallback GitHub login for mention comment filtering', err);
      return undefined;
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
      async ({ issue, repoName }) => ({
        externalId: `${repoName}#${issue.number}`,
        resurfaceVersion: await this.fetchLatestMentionCommentVersion(issue, token, currentLogin, signal),
      }),
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

  private async fetchLatestMentionCommentVersion(
    issue: GitHubIssue,
    token: string,
    currentLogin: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!issue.comments_url) {
      return undefined;
    }

    let response: Response;
    try {
      response = await fetch(GitHubMentionsProvider.withPerPage(issue.comments_url), {
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

    const comments = await response.json() as GitHubIssueComment[];
    let latestMention: { id: number; timestamp: string; time: number } | undefined;
    for (const comment of comments) {
      if (!GitHubMentionsProvider.mentionsUser(comment.body, currentLogin)) {
        continue;
      }
      const timestamp = comment.updated_at ?? comment.created_at;
      if (!timestamp) {
        continue;
      }
      const time = Date.parse(timestamp);
      if (Number.isNaN(time)) {
        continue;
      }
      if (!latestMention || time > latestMention.time) {
        latestMention = { id: comment.id, timestamp, time };
      }
    }

    return latestMention
      ? `comment:${latestMention.id}:${latestMention.timestamp}`
      : undefined;
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

  private static withPerPage(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set('per_page', '100');
      parsed.searchParams.set('sort', 'updated');
      parsed.searchParams.set('direction', 'desc');
      return parsed.toString();
    } catch {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}per_page=100&sort=updated&direction=desc`;
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
