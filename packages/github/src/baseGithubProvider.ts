import * as vscode from 'vscode';
import { isValidGitHubRepo, type ResolvedItem } from '@devdocket/shared';
import { logger } from './logger';

export type { ResolvedItem };

// Re-declared to match core API contract — separate extension cannot import core types directly
export interface Disposable {
  dispose(): void;
}

// Re-declared to match core API contract — separate extension cannot import core types directly
export interface Event<T> {
  (listener: (e: T) => void): Disposable;
}

export interface DiscoveredItem {
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  group?: string;
  reason?: string;
  state?: string;
  version?: string;
  resurfaceVersion?: string;
}

export interface DevDocketProvider {
  readonly id: string;
  readonly label: string;
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;
  refresh(token?: vscode.CancellationToken): Promise<void>;
  resolveUrl?(url: string, signal?: AbortSignal): Promise<ResolvedItem | undefined>;
  getClosedItems?(externalIds: string[], signal?: AbortSignal): Promise<string[]>;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body?: string;
  state?: string;
  html_url: string;
  repository_url: string;
  pull_request?: { url: string };
}

export abstract class BaseGitHubProvider implements DevDocketProvider {
  abstract readonly id: string;
  abstract readonly label: string;

  protected readonly _onDidDiscoverItems = new vscode.EventEmitter<DiscoveredItem[]>();
  readonly onDidDiscoverItems = this._onDidDiscoverItems.event;

  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private _isRefreshing = false;

  startPeriodicRefresh(intervalSeconds: number): void {
    this.stopPeriodicRefresh();
    const interval = Number(intervalSeconds);
    if (!Number.isFinite(interval) || interval <= 0) {
      return;
    }
    // Clamp to minimum of 60 seconds
    const clampedInterval = Math.max(interval, 60);
    this.refreshTimer = setInterval(() => {
      this.refreshInBackground().catch((err) => {
        logger.error(`${this.label} refresh failed`, err);
      });
    }, clampedInterval * 1000);
  }

  stopPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async refresh(token?: vscode.CancellationToken): Promise<void> {
    await this.doRefresh(true, token);
  }

  private async refreshInBackground(): Promise<void> {
    await this.doRefresh(false);
  }

  private async doRefresh(isUserTriggered: boolean, token?: vscode.CancellationToken): Promise<void> {
    if (this._isRefreshing) {
      return;
    }
    this._isRefreshing = true;
    try {
      if (token?.isCancellationRequested) {
        return;
      }

      const createIfNone = isUserTriggered;
      let session: vscode.AuthenticationSession | undefined;
      try {
        session = await vscode.authentication.getSession('github', ['repo'], {
          createIfNone,
        });
      } catch (err) {
        if (isUserTriggered) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('GitHub authentication failed', err);
          vscode.window.showWarningMessage(`DevDocket GitHub: Authentication failed — ${message}`);
        } else {
          logger.warn('GitHub authentication failed during background refresh', err);
        }
        return;
      }

      if (!session || token?.isCancellationRequested) {
        if (!session) {
          if (isUserTriggered) {
            logger.info('User cancelled GitHub authentication');
          } else {
            logger.debug('No GitHub session available for background refresh');
          }
        }
        return;
      }

      await this.fetchAndPublish(session.accessToken, isUserTriggered);
    } catch (err) {
      logger.error(`Failed to fetch ${this.label}`, err);
    } finally {
      this._isRefreshing = false;
    }
  }

  protected abstract fetchAndPublish(accessToken: string, isUserTriggered: boolean): Promise<void>;

  protected parseRepo(issue: GitHubIssue): string {
    const match = issue.html_url.match(/github\.com\/([^/]+\/[^/]+)/);
    if (match) {
      return match[1];
    }

    // Fallback to parsing from repository_url (API URL)
    const apiMatch = issue.repository_url.match(/repos\/([^/]+\/[^/]+)/);
    if (apiMatch) {
      return apiMatch[1];
    }

    // Deterministic fallback: hash the repository_url
    logger.warn(`Could not parse repo from URL: ${issue.html_url}`);
    const hash = issue.repository_url.split('').reduce((acc, char) => {
      return ((acc << 5) - acc) + char.charCodeAt(0) | 0;
    }, 0);
    return `unknown-repo-${Math.abs(hash).toString(36)}`;
  }

  /** Get GitHub API headers, attaching auth if a silent session is available. */
  protected async getHeaders(): Promise<Record<string, string>> {
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
  protected async retryWithAuth(apiUrl: string, signal?: AbortSignal): Promise<Response | undefined> {
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
  protected throwApiError(response: Response, label: string): never {
    if (response.status === 404) {
      throw new Error(`${label} not found. It may be private or deleted.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`GitHub access denied for ${label}. The repo may be private — sign in to GitHub in VS Code, or check rate limits.`);
    }
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  /** Extract canonical owner/repo from a GitHub html_url. */
  protected parseCanonicalRepo(htmlUrl: string, fallbackOwner: string, fallbackRepo: string): string {
    const match = htmlUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\//i);
    return match ? `${match[1]}/${match[2]}` : `${fallbackOwner}/${fallbackRepo}`;
  }

  /** Decode a percent-encoded URL path segment, returning the original on malformed input. */
  protected static safeDecodeComponent(value: string): string {
    try { return decodeURIComponent(value); } catch { return value; }
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
  protected async fetchClosedGitHubItems(
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
      const num = parseInt(id.substring(hashIdx + 1), 10);
      if (isNaN(num) || !isValidGitHubRepo(rawRepo)) { return null; }
      const [owner, repoName] = rawRepo.split('/');
      return { id, owner, repoName, number: num };
    }).filter((p): p is NonNullable<typeof p> => p !== null);

    if (parsed.length === 0) { return []; }

    const closedIds: string[] = [];
    let nextIndex = 0;

    const runWorker = async (): Promise<void> => {
      while (nextIndex < parsed.length) {
        if (signal?.aborted) { break; }
        const currentIndex = nextIndex++;
        const item = parsed[currentIndex];
        try {
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
          if (response.ok) {
            const data = await response.json() as { state?: string };
            if (data.state === 'closed') {
              closedIds.push(item.id);
            }
          } else {
            logger.debug(`Failed to check ${apiType} ${item.id}: ${response.status}`);
          }
        } catch (err) {
          if (signal?.aborted) { break; }
          logger.debug(`Failed to check ${apiType} ${item.id}: ${String(err)}`);
        }
      }
    };

    const workerCount = Math.min(5, parsed.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    return closedIds;
  }

  dispose(): void {
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }
}
