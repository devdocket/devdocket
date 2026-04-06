// Minimal re-declarations to avoid depending on the vscode module
export interface Disposable {
  dispose(): void;
}

export interface Event<T> {
  (listener: (e: T) => void): Disposable;
}

export interface DiscoveredItem {
  externalId: string;
  title: string;
  description?: string;
  url?: string;
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
 * Owns the EventEmitter lifecycle, refresh timer, concurrency guard, and dispose logic.
 */
export abstract class BaseProvider {
  protected readonly _onDidDiscoverItems: EventEmitterLike<DiscoveredItem[]>;
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;

  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private _isRefreshing = false;
  private _disposed = false;

  /** Optional error handler for background refresh failures. Override to add logging. */
  protected onBackgroundRefreshError: (error: unknown) => void = () => {};

  constructor(emitter: EventEmitterLike<DiscoveredItem[]>) {
    this._onDidDiscoverItems = emitter;
    this.onDidDiscoverItems = emitter.event;
  }

  startPeriodicRefresh(intervalSeconds: number): void {
    if (this._disposed) {
      return;
    }
    this.stopPeriodicRefresh();
    const interval = Number(intervalSeconds);
    if (!Number.isFinite(interval) || interval <= 0) {
      return;
    }
    const clampedInterval = Math.max(interval, 60);
    this.refreshTimer = setInterval(() => {
      this.refreshInBackground().catch((error: unknown) => {
        try {
          this.onBackgroundRefreshError(error);
        } catch {
          // Prevent handler errors from becoming unhandled rejections
        }
      });
    }, clampedInterval * 1000);
  }

  stopPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /** Runs a background refresh with a concurrency guard to prevent overlapping calls. */
  async refreshInBackground(): Promise<void> {
    if (this._isRefreshing || this._disposed) {
      return;
    }
    this._isRefreshing = true;
    try {
      await this.doBackgroundRefresh();
    } finally {
      this._isRefreshing = false;
    }
  }

  /** Override to provide the background refresh implementation. */
  protected abstract doBackgroundRefresh(): Promise<void>;

  abstract refresh(): Promise<void>;

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }
}
