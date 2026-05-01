// Minimal re-declarations to avoid depending on the vscode module

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
  /** Optional flag indicating the current user authored the item. */
  authored?: boolean;
  /** Optional grouping key used to organize items in the UI (for example, in the Inbox and Sources views). */
  group?: string;
  /** Optional notification reason explaining why this item was surfaced (e.g. `"assigned"`, `"review_requested"`). */
  reason?: string;
  /** Optional upstream state from the provider (e.g. `"open"`, `"closed"`, `"Active"`). */
  state?: string;
  /**
   * Optional version identifier for "soft" resurfacing.
   * When a previously accepted item reappears with a different version,
   * it is resurfaced in the Inbox as unseen **unless** the linked work item
   * is currently in Queue or Focus (New, InProgress, Paused), in which case
   * the version is silently updated and a `version-updated` activity is logged.
   */
  version?: string;
  /**
   * Optional secondary version for "hard" resurfacing.
   * When a previously accepted item reappears with a different
   * resurfaceVersion, it is **always** resurfaced in the Inbox as unseen,
   * regardless of the linked work item's state.
   */
  resurfaceVersion?: string;
  /**
   * Optional cross-provider deduplication key.
   * When set, items from different providers that share the same `canonicalId`
   * are grouped in the Inbox view and only one representative is shown.
   * Accept/dismiss/read-state actions propagate to all items in the group.
   * Items without `canonicalId` always show individually (backward compatible).
   */
  canonicalId?: string;
}

/**
 * Result returned by a provider's `resolveUrl` method when it recognises a URL.
 * Contains enough detail for the core extension to create a work item.
 */
export interface ResolvedItem {
  title: string;
  notes: string;
  url: string;
  externalId: string;
  group?: string;
  providerId: string;
}

/** Matches the subset of vscode.EventEmitter used by providers. */
export interface EventEmitterLike<T> {
  event: Event<T>;
  fire(data: T): void;
  dispose(): void;
}

/**
 * Base class for DevDocket providers that need periodic refresh.
 * Owns the EventEmitter lifecycle, refresh timer, concurrency guard, and dispose logic.
 */
export abstract class BaseProvider {
  protected readonly _onDidDiscoverItems: EventEmitterLike<DiscoveredItem[]>;
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;

  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  protected _isRefreshing = false;
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

  abstract refresh(token?: unknown): Promise<void>;

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }
}
