import * as vscode from 'vscode';
import { BaseProvider, ProviderItem, createAbortError, runWorkerPool, type ProviderRefreshOptions, type RelatedItemRef } from '@devdocket/shared';
import { fetchPrCrossReferencesBatch } from './githubGraphql';
import { GitHubSsoError, getGitHubSession } from './githubApiHelpers';
import { logger } from './logger';
import { matchesRepoPatterns, parseRepoPatterns, type RepoPattern } from './repoPattern';

const RELATED_ITEMS_BATCH_SIZE = 10;
const OPEN_SETTINGS = 'Open Settings';
const SIGN_IN = 'Sign in';
const AUTHORIZE_IN_BROWSER = 'Authorize in browser';
const RETRY = 'Retry';
const DISMISS = 'Dismiss';
const GITHUB_SETTINGS_QUERY = '@ext:devdocket.devdocket-github';
// Background refreshes are deduplicated per org for the lifetime of this session
// so polling does not resurface the same SSO prompt every few minutes.
const notifiedGitHubSsoOrgs = new Set<string>();

export function resetGitHubSsoNotificationDedupeForTests(): void {
  notifiedGitHubSsoOrgs.clear();
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
    super(new vscode.EventEmitter<ProviderItem[]>());
    this.onBackgroundRefreshError = (error) => {
      logger.error(`${this.label} refresh failed`, error);
    };
  }

  protected getAuthenticationScopes(): string[] {
    return ['repo'];
  }

  async refresh(token?: vscode.CancellationToken, options?: ProviderRefreshOptions): Promise<void> {
    if (this._isRefreshing) {
      return;
    }

    this._isRefreshing = true;
    const abortController = new AbortController();
    const cancelListener = token?.onCancellationRequested?.(() => abortController.abort());
    const interactive = options?.interactive ?? true;
    try {
      if (token?.isCancellationRequested) {
        return;
      }

      let session: vscode.AuthenticationSession | undefined;
      try {
        session = await getGitHubSession(this.getAuthenticationScopes(), {
          interactive,
          signal: abortController.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.error('GitHub authentication failed', err);
        this.showGitHubAuthenticationWarning(`DevDocket GitHub: Authentication failed — ${message}`);
        return;
      }

      if (!session || token?.isCancellationRequested) {
        if (!session) {
          if (interactive) {
            logger.info('User cancelled GitHub authentication');
          } else {
            logger.debug('No cached GitHub session available for non-interactive refresh');
          }
        }
        return;
      }

      await this.fetchAndPublish(session.accessToken, interactive, abortController.signal);
      this.markRefreshSuccess();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && abortController.signal.aborted && token?.isCancellationRequested) {
        logger.debug(`${this.label} fetch aborted due to cancellation`);
      } else {
        if (err instanceof GitHubSsoError) {
          this.showGitHubSsoNotification(err, () => this.refresh(undefined, { interactive: true }));
        }
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

    try {
      await this.fetchAndPublish(session.accessToken, false);
    } catch (err) {
      if (err instanceof GitHubSsoError) {
        this.showGitHubSsoNotification(err, () => this.refreshInBackground(), true);
      }
      throw err;
    }
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
    await runWorkerPool(chunkArray(prs, RELATED_ITEMS_BATCH_SIZE), async (batch) => {
      if (signal?.aborted) {
        throw createAbortError();
      }
      try {
        const relatedItemsByPr = await fetchPrCrossReferencesBatch(
          accessToken,
          batch.map(pr => ({ owner: pr.repoOwner, name: pr.repoName, number: pr.number })),
          signal,
        );
        batch.forEach((pr, index) => {
          const batchResult = relatedItemsByPr[index];
          if (batchResult?.error) {
            failureCount++;
            logger.warn(`Failed to fetch related items for PR ${pr.externalId}: ${batchResult.error}`);
            return;
          }
          const relatedItems = batchResult?.relatedItems ?? [];
          if (relatedItems.length > 0) {
            result.set(pr.externalId, relatedItems);
          }
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError' && signal?.aborted) { throw error; }
        failureCount += batch.length;
        for (const pr of batch) {
          logger.warn(`Failed to fetch related items for PR ${pr.externalId}: ${String(error)}`);
        }
      }
    }, 2);

    const summary = `Found related items for ${result.size}/${prs.length} PRs (${failureCount} failures)`;
    if (failureCount > 0 || result.size > 0) {
      logger.info(summary);
    } else {
      logger.debug(summary);
    }
    return result;
  }

  /**
   * Publish GitHub items after applying repository filters at the provider boundary.
   */
  protected publishProviderItems(items: ProviderItem[], patterns: RepoPattern[] = this.getConfiguredPatterns()): void {
    this._onDidDiscoverItems.fire(this.applyConfiguredRepoFilter(items, patterns));
  }

  /**
   * Apply the `devDocketGithub.filteredRepos` setting to discovered items.
   */
  protected applyConfiguredRepoFilter<T extends Pick<ProviderItem, 'externalId' | 'group'>>(items: T[], patterns: RepoPattern[] = this.getConfiguredPatterns()): T[] {
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

  private getRepoName(item: Pick<ProviderItem, 'externalId' | 'group'>): string | undefined {
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
      this.showGitHubSettingsWarning(`DevDocket GitHub: ${message}`);
    } else {
      logger.warn(message);
    }
  }

  private showGitHubAuthenticationWarning(message: string): void {
    void vscode.window.showWarningMessage(message, SIGN_IN).then(action => {
      if (action === SIGN_IN) {
        void vscode.authentication.getSession('github', this.getAuthenticationScopes(), { createIfNone: true })
          .catch(err => logger.error('GitHub sign-in failed', err));
      }
    });
  }

  private showGitHubSsoNotification(error: GitHubSsoError, retry: (() => Promise<void> | void) | undefined, dedupeByOrg = false): void {
    const dedupeKey = error.orgName ?? error.ssoUrl ?? error.message;
    if (dedupeByOrg && notifiedGitHubSsoOrgs.has(dedupeKey)) {
      return;
    }
    if (dedupeByOrg) {
      notifiedGitHubSsoOrgs.add(dedupeKey);
    }

    const orgLabel = error.orgName
      ? `the "${error.orgName}" organization`
      : 'this organization';
    const message = dedupeByOrg
      ? `DevDocket: GitHub requires SSO authorization for ${orgLabel}\nbefore DevDocket can refresh items from it.`
      : `DevDocket: GitHub requires SSO authorization for ${orgLabel}\nbefore this item can be loaded.`;
    const actions = retry
      ? [AUTHORIZE_IN_BROWSER, RETRY, DISMISS] as const
      : [AUTHORIZE_IN_BROWSER, DISMISS] as const;

    void Promise.resolve(vscode.window.showErrorMessage(message, ...actions)).then(async action => {
      if (action === AUTHORIZE_IN_BROWSER && error.ssoUrl) {
        if (dedupeByOrg) {
          notifiedGitHubSsoOrgs.delete(dedupeKey);
        }
        await vscode.env.openExternal(vscode.Uri.parse(error.ssoUrl));
        return;
      }
      if (action === RETRY && retry) {
        if (dedupeByOrg) {
          notifiedGitHubSsoOrgs.delete(dedupeKey);
        }
        try {
          await retry();
        } catch (retryError) {
          logger.error('GitHub SSO retry failed', retryError);
        }
      }
    });
  }

  private showGitHubSettingsWarning(message: string): void {
    void vscode.window.showWarningMessage(message, OPEN_SETTINGS).then(action => {
      if (action === OPEN_SETTINGS) {
        void vscode.commands.executeCommand('workbench.action.openSettings', GITHUB_SETTINGS_QUERY);
      }
    });
  }

}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
