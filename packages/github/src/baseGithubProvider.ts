import * as vscode from 'vscode';
import { BaseProvider, DiscoveredItem } from '@devdocket/shared';
import { logger } from './logger';
import { parseRepoPatterns, isNegationOnly, type RepoPattern } from './repoPattern';
import { resolveRepos } from './repoResolver';

export interface ResolvedRepoConfig {
  repos: string[];
  patterns: RepoPattern[];
  useGlobalFetch: boolean;
}

/**
 * Base class for GitHub providers that handles the common authentication
 * pattern and concurrency guards for refresh operations.
 *
 * Providers extend this class and implement fetchAndPublish() to define
 * their specific discovery logic.
 */
export abstract class BaseGitHubProvider extends BaseProvider {
  abstract readonly id: string;
  abstract readonly label: string;

  constructor() {
    super(new vscode.EventEmitter<DiscoveredItem[]>());
    this.onBackgroundRefreshError = (error) => {
      logger.error(`${this.label} refresh failed`, error);
    };
  }

  async refresh(token?: vscode.CancellationToken): Promise<void> {
    if (this._isRefreshing) {
      return;
    }

    this._isRefreshing = true;
    const abortController = new AbortController();
    const cancelListener = token?.onCancellationRequested?.(() => abortController.abort());
    try {
      if (token?.isCancellationRequested) {
        return;
      }

      let session: vscode.AuthenticationSession | undefined;
      try {
        session = await vscode.authentication.getSession('github', ['repo'], {
          createIfNone: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('GitHub authentication failed', err);
        vscode.window.showWarningMessage(`DevDocket GitHub: Authentication failed — ${message}`);
        return;
      }

      if (!session || token?.isCancellationRequested) {
        if (!session) {
          logger.info('User cancelled GitHub authentication');
        }
        return;
      }

      await this.fetchAndPublish(session.accessToken, true, abortController.signal);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && abortController.signal.aborted && token?.isCancellationRequested) {
        logger.debug(`${this.label} fetch aborted due to cancellation`);
      } else {
        logger.error(`Failed to fetch ${this.label}`, err);
      }
    } finally {
      cancelListener?.dispose();
      this._isRefreshing = false;
    }
  }

  protected async doBackgroundRefresh(): Promise<void> {
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: false,
      });
    } catch (err) {
      logger.warn('GitHub authentication failed during background refresh', err);
      return;
    }

    if (!session) {
      logger.debug('No GitHub session available for background refresh');
      return;
    }

    await this.fetchAndPublish(session.accessToken, false);
  }

  /**
   * Fetch items from GitHub API and publish them via the event emitter.
   *
   * @param accessToken GitHub auth token
   * @param isUserTriggered Whether this is a user-initiated refresh
   * @param signal Optional AbortSignal for cancellation
   */
  protected abstract fetchAndPublish(
    accessToken: string,
    isUserTriggered: boolean,
    signal?: AbortSignal
  ): Promise<void>;

  /**
   * Read the `devDocketGithub.repos` setting and parse it into repo patterns.
   * Handles backward compatibility with the old string[] config format.
   */
  protected getConfiguredPatterns(): RepoPattern[] {
    const config = vscode.workspace.getConfiguration('devDocketGithub');
    const value = config.get<string | string[]>('repos', '');
    if (!value || (Array.isArray(value) && value.length === 0)) { return []; }
    // Backward compat: handle old array format
    if (Array.isArray(value)) {
      return parseRepoPatterns(value.join('\n'));
    }
    return parseRepoPatterns(value);
  }

  /**
   * Resolve configured patterns into concrete repo names and fetch strategy.
   * Returns empty repos with useGlobalFetch=true when no patterns are configured
   * or when only negation patterns exist (requiring a global fetch + post-filter).
   */
  protected async resolveConfiguredRepos(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<ResolvedRepoConfig> {
    const patterns = this.getConfiguredPatterns();

    if (patterns.length === 0) {
      return { repos: [], patterns, useGlobalFetch: true };
    }

    if (isNegationOnly(patterns)) {
      return { repos: [], patterns, useGlobalFetch: true };
    }

    const repos = await resolveRepos(patterns, accessToken, signal);
    return { repos, patterns, useGlobalFetch: false };
  }
}
