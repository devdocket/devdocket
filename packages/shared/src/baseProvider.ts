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
 * A reference from one ProviderItem to another, supplied by the provider.
 * Used by the core to render navigable "Related" links.
 *
 * Resolution is live (no persistence): when provider data no longer contains
 * the reference, the affordance disappears on the next render.
 */
export interface RelatedItemRef {
  /** Provider-scoped identifier of the related item, e.g. "owner/repo#123". */
  externalId: string;
  /** Whether the relationship is a closing reference or a plain mention. */
  relation: 'closes' | 'linked';
  /** What kind of item the reference points to. */
  itemType: 'issue' | 'pr';
}


/**
 * Information a provider supplies so that the Start Git Work action (or any
 * other git-aware action) can do its job without knowing anything about the
 * provider's host or URL shape.
 *
 * Providers are responsible for fetching all underlying data (e.g. PR head
 * ref via the host's API). Returning a function defers that work until the
 * action actually runs.
 */
export interface GitWorkInfo {
  /** 'issue' = create a new branch; 'pr' = check out an existing branch. */
  kind: 'issue' | 'pr';
  /**
   * URL to clone the repo containing this work item (or its base for a PR).
   * Must be a clone-style URL (https or git@host:owner/repo.git).
   */
  cloneUrl: string;
  /**
   * For 'issue': suggested branch name to create.
   * For 'pr': the head ref (branch name) to check out.
   */
  ref: string;
  /**
   * For 'pr' from a fork: the head repository's clone URL when it differs
   * from `cloneUrl`. When set, the action will fetch the head ref from this
   * remote rather than from `cloneUrl`.
   */
  headCloneUrl?: string;
  /** For 'pr': base ref the PR is targeting (informational, optional). */
  baseRef?: string;
  /**
   * Optional human-readable label for the source repo, used in prompts.
   * E.g. "owner/repo" or "ProjectName / repoName".
   */
  repoLabel?: string;
}

/**
 * Capabilities a provider attaches to a provider item to opt into
 * cross-cutting actions (e.g. Start Git Work). All capabilities are optional.
 */
export interface ProviderItemCapabilities {
  /**
   * Indicates this item can be the basis for git-based development work.
   * Either a literal {@link GitWorkInfo} (when all data is known upfront)
   * or a thunk that resolves it lazily (when an API call is needed).
   * Returning `undefined` from the thunk means "not currently resolvable".
   */
  gitWork?: GitWorkInfo | (() => Promise<GitWorkInfo | undefined>);
}

export interface ProviderItemAuthor {
  /** Display name preferred for UI, e.g. "Octocat" or "Jane Doe". */
  displayName: string;
  /** Optional stable handle, e.g. GitHub login or ADO uniqueName. */
  handle?: string;
  /** Optional avatar URL for future richer rendering. */
  avatarUrl?: string;
  /** Optional URL to the author's source-system profile. */
  profileUrl?: string;
}

/**
 * An item discovered by a provider.
 * Provider data is kept in memory and read live — only the inbox state is persisted.
 */
export interface ProviderItem {
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
  /** Optional metadata about who created the underlying item upstream. */
  author?: ProviderItemAuthor;
  /** Optional grouping key used to organize items in the UI (for example, in the Inbox and Sources views). */
  group?: string;
  /** Optional notification reason explaining why this item was surfaced (e.g. `"assigned"`, `"review_requested"`). */
  reason?: string;
  /** Optional upstream state from the provider (e.g. `"open"`, `"closed"`, `"Active"`). */
  state?: string;
  /**
   * Optional classification of the item kind ("issue" or "pr"). Providers set
   * this so the UI can render a distinct type badge without inferring from URL
   * patterns or state strings.
   */
  itemType?: 'issue' | 'pr';
  /** Optional refs to other discovered items (e.g. issues a PR closes/mentions). */
  relatedItems?: RelatedItemRef[];
  /**
   * Optional provider-declared badges to render alongside the core-managed
   * Provider / Type / CI badges. Use these to surface state-like information
   * (e.g. "Approved", "Changes requested", "Mentioned") in a way the core
   * extension does not have to know about. The core never infers badges from
   * the {@link state} or {@link reason} strings — only what's listed here is
   * rendered.
   */
  badges?: ProviderBadge[];
  /**
   * Optional version identifier for accepted-item resurfacing.
   * When a previously accepted item reappears with a different version,
   * it is resurfaced in Incoming as unseen only if no linked work item exists
   * or the linked work item is Done/Archived. For linked work items in
   * New/InProgress/Paused, the version is silently updated.
   */
  version?: string;
  /**
   * Optional secondary version for accepted and dismissed item resurfacing.
   * After the core records an item's first seen resurfaceVersion, later
   * changes resurface the item in Incoming as unseen only if no linked work
   * item exists or the linked work item is Done/Archived. For linked work
   * items in New/InProgress/Paused, the resurfaceVersion is silently updated.
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
  /** Optional provider-supplied capabilities for cross-cutting actions. */
  capabilities?: ProviderItemCapabilities;
}


/**
 * A badge rendered alongside the core-managed Provider / Type / CI badges.
 * Providers declare these explicitly — the core extension never infers badges
 * from {@link ProviderItem.state} or {@link ProviderItem.reason}.
 */
export interface ProviderBadge {
  /** Display text. Keep short — sidebar badges compete with the title. */
  label: string;
  /**
   * Severity hint that drives the badge's color and visual treatment. The core
   * maps each variant to a theme-aware palette so providers don't have to
   * pick raw colors.
   *
   * - `neutral` — outlined, no fill. Use for category labels.
   * - `info`    — blue. Use for informational state (e.g. "Open").
   * - `success` — green. Use for positive state (e.g. "Approved").
   * - `warning` — amber. Use for pending action (e.g. "Review requested").
   * - `danger`  — red. Use for action needed (e.g. "Changes requested").
   */
  variant: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  /**
   * Where to render. Defaults to `'both'`. Use `'editor'` for verbose detail
   * badges that would clutter the sidebar; use `'sidebar'` for the rare case
   * where the badge is only useful in the inbox triage flow.
   */
  show?: 'sidebar' | 'editor' | 'both';
}

/**
 * Result returned by a provider's `resolveUrl` method when it recognizes a URL.
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

/**
 * Abstraction over window focus state, allowing BaseProvider to gate
 * background refreshes without depending on the vscode module.
 * The core extension provides the concrete implementation.
 */
export interface WindowStateProvider {
  /** Whether the window is currently focused. */
  readonly isFocused: boolean;
  /** Fires when focus state changes. */
  readonly onDidChangeFocus: Event<boolean>;
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
  /** Multiplier for the unfocused-window polling interval. Matches the pattern
   *  used by Microsoft's vscode-pull-request-github extension (2min focused,
   *  5min unfocused = 2.5x). */
  private static readonly UNFOCUSED_INTERVAL_MULTIPLIER = 2.5;

  protected readonly _onDidDiscoverItems: EventEmitterLike<ProviderItem[]>;
  readonly onDidDiscoverItems: Event<ProviderItem[]>;

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private periodicRefreshIntervalMs: number | undefined;
  private _lastRefreshTime = 0;
  private _lastRefreshAttemptTime = 0;
  protected _isRefreshing = false;
  private _disposed = false;

  private _windowState: WindowStateProvider | undefined;
  private _windowStateSub: Disposable | undefined;

  /** Optional error handler for background refresh failures. Override to add logging. */
  protected onBackgroundRefreshError: (error: unknown) => void = () => {};

  protected markRefreshSuccess(): void {
    this._lastRefreshTime = Date.now();
  }

  private handleBackgroundRefreshError(error: unknown): void {
    try {
      this.onBackgroundRefreshError(error);
    } catch {
      // Prevent handler errors from becoming unhandled rejections
    }
  }

  private triggerPeriodicRefresh(): void {
    this._lastRefreshAttemptTime = Date.now();
    this.refreshInBackground()
      .catch((error: unknown) => {
        this.handleBackgroundRefreshError(error);
      })
      .finally(() => {
        this.scheduleNextPeriodicRefresh();
      });
  }

  private getRequiredRefreshIntervalMs(): number | undefined {
    const focusedIntervalMs = this.periodicRefreshIntervalMs;
    if (!focusedIntervalMs) {
      return undefined;
    }
    return this._windowState?.isFocused === false
      ? focusedIntervalMs * BaseProvider.UNFOCUSED_INTERVAL_MULTIPLIER
      : focusedIntervalMs;
  }

  private scheduleNextPeriodicRefresh(): void {
    if (this._disposed) {
      return;
    }
    const requiredIntervalMs = this.getRequiredRefreshIntervalMs();
    if (!requiredIntervalMs) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    const elapsedMs = Date.now() - this._lastRefreshAttemptTime;
    const intervalsElapsed = Math.floor(elapsedMs / requiredIntervalMs) + 1;
    const delayMs = (intervalsElapsed * requiredIntervalMs) - elapsedMs;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this._disposed) {
        return;
      }
      if (this._isRefreshing) {
        this.scheduleNextPeriodicRefresh();
        return;
      }
      this.triggerPeriodicRefresh();
    }, delayMs);
  }

  private refreshOnFocusIfStale(): void {
    const focusedIntervalMs = this.periodicRefreshIntervalMs;
    if (this._disposed || !focusedIntervalMs || this._isRefreshing || !this._windowState?.isFocused) {
      return;
    }
    if (Date.now() - this._lastRefreshTime <= focusedIntervalMs) {
      return;
    }
    this.triggerPeriodicRefresh();
  }

  constructor(emitter: EventEmitterLike<ProviderItem[]>) {
    this._onDidDiscoverItems = emitter;
    this.onDidDiscoverItems = emitter.event;
  }

  /**
   * Provides window focus state so background refreshes can be throttled when
   * the window is unfocused. On focus gain, an immediate refresh is triggered
   * when the focused polling interval has already elapsed.
   */
  setWindowState(provider: WindowStateProvider): void {
    if (this._disposed) {
      return;
    }
    this._windowStateSub?.dispose();
    this._windowState = provider;
    this._windowStateSub = provider.onDidChangeFocus((focused) => {
      if (focused) {
        this.refreshOnFocusIfStale();
      }
      this.scheduleNextPeriodicRefresh();
    });
    this.scheduleNextPeriodicRefresh();
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
    const startTime = Date.now();
    this.periodicRefreshIntervalMs = clampedInterval * 1000;
    this._lastRefreshTime = startTime;
    this._lastRefreshAttemptTime = startTime;
    this.scheduleNextPeriodicRefresh();
  }

  stopPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.periodicRefreshIntervalMs = undefined;
  }

  /** Runs a background refresh with a concurrency guard to prevent overlapping calls. */
  async refreshInBackground(): Promise<void> {
    if (this._isRefreshing || this._disposed) {
      return;
    }
    this._isRefreshing = true;
    try {
      await this.doBackgroundRefresh();
      this.markRefreshSuccess();
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
    this._windowStateSub?.dispose();
    this._onDidDiscoverItems.dispose();
  }
}
