import * as vscode from 'vscode';
import { logger } from './logger';

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
  version?: string;
}

export interface DevDocketProvider {
  readonly id: string;
  readonly label: string;
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;
  refresh(token?: vscode.CancellationToken): Promise<void>;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body?: string;
  html_url: string;
  repository_url: string;
  pull_request?: unknown;
  updated_at?: string;
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

  dispose(): void {
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }
}
