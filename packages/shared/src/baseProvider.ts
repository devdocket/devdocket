import * as vscode from 'vscode';
import type { DiscoveredItem, WorkCenterProvider } from './types';

/**
 * Abstract base class for WorkCenter providers.
 *
 * Handles the common boilerplate shared by all providers:
 * - `vscode.EventEmitter` setup for {@link onDidDiscoverItems}
 * - Periodic refresh timer with minimum-interval clamping
 * - Concurrency guard (`_isRefreshing`) to prevent overlapping refreshes
 * - `dispose()` cleanup for the timer and emitter
 *
 * Subclasses implement {@link doRefresh} for the actual data fetching.
 * Override {@link doBackgroundRefresh} when background refreshes need
 * different behavior (e.g., skipping interactive auth prompts).
 *
 * @example
 * ```ts
 * class JiraProvider extends BaseProvider {
 *   readonly id = 'jira';
 *   readonly label = 'Jira Issues';
 *
 *   protected async doRefresh(): Promise<void> {
 *     const tickets = await this.fetchTickets();
 *     this.fireDiscoveredItems(tickets.map(t => ({
 *       externalId: t.key,
 *       title: t.summary,
 *     })));
 *   }
 * }
 * ```
 */
export abstract class BaseProvider implements WorkCenterProvider {
  abstract readonly id: string;
  abstract readonly label: string;
  readonly resurfaceDismissed?: boolean;

  private readonly _onDidDiscoverItems = new vscode.EventEmitter<DiscoveredItem[]>();
  readonly onDidDiscoverItems = this._onDidDiscoverItems.event;

  private _refreshTimer: ReturnType<typeof setInterval> | undefined;
  protected _isRefreshing = false;

  /** Emit a new set of discovered items, replacing any previous set. */
  protected fireDiscoveredItems(items: DiscoveredItem[]): void {
    this._onDidDiscoverItems.fire(items);
  }

  /**
   * Called by WorkCenter on registration for initial discovery, and by
   * the user when manually refreshing. The concurrency guard ensures
   * overlapping calls are skipped.
   */
  async refresh(token?: vscode.CancellationToken): Promise<void> {
    if (this._isRefreshing) {
      return;
    }
    this._isRefreshing = true;
    try {
      await this.doRefresh(token);
    } finally {
      this._isRefreshing = false;
    }
  }

  /**
   * Subclasses implement this to fetch data from their external source
   * and call {@link fireDiscoveredItems} with the results.
   */
  protected abstract doRefresh(token?: vscode.CancellationToken): Promise<void>;

  /**
   * Called by the periodic timer for non-interactive refresh.
   * Override when background refreshes need different behavior than
   * interactive ones (e.g., using `createIfNone: false` for auth sessions).
   * Defaults to calling {@link doRefresh} with no cancellation token.
   */
  protected async doBackgroundRefresh(): Promise<void> {
    await this.doRefresh();
  }

  /**
   * Called when a background refresh throws. Override to log or report
   * the error. By default this is a no-op; errors are swallowed to
   * prevent unhandled promise rejections from crashing the timer loop.
   */
  protected onBackgroundRefreshError(err: unknown): void {
    // Override in subclasses to log errors, e.g.:
    // logger.error('Background refresh failed', err);
    void err;
  }

  /**
   * Start a periodic refresh on a `setInterval` timer.
   * The interval is clamped to a minimum of 60 seconds.
   * Values ≤ 0 or non-finite values are ignored (no timer is started).
   */
  startPeriodicRefresh(intervalSeconds: number): void {
    this.stopPeriodicRefresh();
    const interval = Number(intervalSeconds);
    if (!Number.isFinite(interval) || interval <= 0) {
      return;
    }
    const clampedInterval = Math.max(interval, 60);
    this._refreshTimer = setInterval(() => {
      if (this._isRefreshing) {
        return;
      }
      this._isRefreshing = true;
      this.doBackgroundRefresh()
        .catch((err: unknown) => {
          this.onBackgroundRefreshError(err);
        })
        .finally(() => {
          this._isRefreshing = false;
        });
    }, clampedInterval * 1000);
  }

  /** Stop the periodic refresh timer, if running. */
  stopPeriodicRefresh(): void {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = undefined;
    }
  }

  /** Stop the timer and dispose the event emitter. */
  dispose(): void {
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }
}
