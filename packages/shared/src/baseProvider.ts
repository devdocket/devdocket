/** A handle that releases a resource when disposed. */
export interface Disposable {
  dispose(): void;
}

/** A typed event that listeners can subscribe to. */
export interface Event<T> {
  (listener: (e: T) => void): Disposable;
}

/**
 * An item discovered by a provider.
 * Provider data is kept in memory and read live — only the inbox state is persisted.
 */
export interface DiscoveredItem {
  /** Provider-scoped unique identifier (e.g. GitHub issue number). */
  externalId: string;
  /** Short display title shown in Inbox and Sources views. */
  title: string;
  /** Optional longer description of the item. */
  description?: string;
  /** Optional URL linking back to the item in its source system. */
  url?: string;
  /** Optional grouping key used to organize items in the UI (for example, in the Inbox and Sources views). */
  group?: string;
}

/** Matches the subset of vscode.EventEmitter used by providers. */
export interface EventEmitterLike<T> {
  event: Event<T>;
  fire(data: T): void;
  dispose(): void;
}

/**
 * Base class for WorkCenter providers that need periodic refresh.
 * Owns the EventEmitter lifecycle, refresh timer, and dispose logic.
 */
export abstract class BaseProvider {
  protected readonly _onDidDiscoverItems: EventEmitterLike<DiscoveredItem[]>;
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;

  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  protected _isRefreshing = false;

  constructor(emitter: EventEmitterLike<DiscoveredItem[]>) {
    this._onDidDiscoverItems = emitter;
    this.onDidDiscoverItems = emitter.event;
  }

  startPeriodicRefresh(intervalSeconds: number): void {
    this.stopPeriodicRefresh();
    const interval = Number(intervalSeconds);
    if (!Number.isFinite(interval) || interval <= 0) {
      return;
    }
    const clampedInterval = Math.max(interval, 60);
    this.refreshTimer = setInterval(() => {
      this.refreshInBackground().catch(() => {
        // Errors are already handled inside refreshInBackground()
      });
    }, clampedInterval * 1000);
  }

  stopPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  protected abstract refreshInBackground(): Promise<void>;

  abstract refresh(): Promise<void>;

  dispose(): void {
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }
}
