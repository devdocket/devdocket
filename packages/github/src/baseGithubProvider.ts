import * as vscode from 'vscode';
import { BaseProvider, DiscoveredItem, createAbortError, runWorkerPool, type RelatedItemRef } from '@devdocket/shared';
import { fetchPrCrossReferences } from './githubGraphql';
import { logger } from './logger';
import { matchesRepoPatterns, parseRepoPatterns, type RepoPattern } from './repoPattern';

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

  protected getAuthenticationScopes(): string[] {
    return ['repo'];
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
        session = await vscode.authentication.getSession('github', this.getAuthenticationScopes(), {
          createIfNone: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('GitHub authentication failed', err);
        void vscode.window.showWarningMessage(`DevDocket GitHub: Authentication failed — ${message}`);
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
      session = await vscode.authentication.getSession('github', this.getAuthenticationScopes(), {
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
   * Fetch GitHub issue/PR references for PRs. Individual PR failures are logged
   * and omitted so supplemental relationship data never blocks refresh.
   */
  protected async fetchRelatedItemsForPRs(
    prs: Array<{ externalId: string; repoOwner: string; repoName: string; number: number }>,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<Map<string, RelatedItemRef[]>> {
    const result = new Map<string, RelatedItemRef[]>();
    if (prs.length === 0) {
      return result;
    }

    let failureCount = 0;
    await runWorkerPool(prs, async (pr) => {
      if (signal?.aborted) {
        throw createAbortError();
      }
      try {
        const relatedItems = await fetchPrCrossReferences(
          accessToken,
          { owner: pr.repoOwner, name: pr.repoName, number: pr.number },
          signal,
        );
        if (relatedItems.length > 0) {
          result.set(pr.externalId, relatedItems);
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError' && signal?.aborted) { throw error; }
        failureCount++;
        logger.warn(`Failed to fetch related items for PR ${pr.externalId}: ${String(error)}`);
      }
    }, 3);

    logger.info(`Fetched related items for ${result.size}/${prs.length} PRs (${failureCount} failures)`);
    return result;
  }

  /**
   * Publish GitHub items after applying repository filters at the provider boundary.
   */
  protected publishDiscoveredItems(items: DiscoveredItem[], patterns: RepoPattern[] = this.getConfiguredPatterns()): void {
    this._onDidDiscoverItems.fire(this.applyConfiguredRepoFilter(items, patterns));
  }

  /**
   * Apply the `devDocketGithub.filteredRepos` setting to discovered items.
   */
  protected applyConfiguredRepoFilter<T extends Pick<DiscoveredItem, 'externalId' | 'group'>>(items: T[], patterns: RepoPattern[] = this.getConfiguredPatterns()): T[] {
    if (patterns.length === 0) { return items; }

    return items.filter(item => {
      const repoName = this.getRepoName(item);
      return repoName ? matchesRepoPatterns(repoName, patterns) : true;
    });
  }

  /**
   * Read the `devDocketGithub.filteredRepos` setting and parse it into repo patterns.
   */
  protected getConfiguredPatterns(): RepoPattern[] {
    const config = vscode.workspace.getConfiguration('devDocketGithub');
    const value = config.get<string>('filteredRepos', '');
    if (!value || typeof value !== 'string') { return []; }
    return parseRepoPatterns(value);
  }

  private getRepoName(item: Pick<DiscoveredItem, 'externalId' | 'group'>): string | undefined {
    const group = item.group?.trim();
    if (group) { return group; }

    const hashIndex = item.externalId.indexOf('#');
    if (hashIndex > 0) {
      const repoName = item.externalId.slice(0, hashIndex).trim();
      if (repoName.includes('/')) { return repoName; }
    }

    return undefined;
  }

  /**
   * Logs a fetch-failure warning and, when the refresh was user-triggered,
   * also surfaces it as a VS Code notification. All GitHub provider fetch
   * failures should go through this helper so the message format stays
   * consistent.
   */
  protected warnOnFetchFailure(message: string, isUserTriggered: boolean): void {
    if (isUserTriggered) {
      void vscode.window.showWarningMessage(`DevDocket GitHub: ${message}`);
    } else {
      logger.warn(message);
    }
  }

}
