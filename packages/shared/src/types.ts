/** A handle that releases a resource when disposed. */
export interface Disposable {
  dispose(): void;
}

/** A typed event that listeners can subscribe to. */
export interface Event<T> {
  (listener: (e: T) => void): Disposable;
}

/**
 * An item discovered by a {@link WorkCenterProvider}.
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

/**
 * A provider that discovers work items from an external source (e.g. GitHub Issues).
 *
 * Providers are registered via {@link WorkCenterApi.registerProvider} and emit
 * {@link DiscoveredItem}s through the {@link onDidDiscoverItems} event. The core
 * extension reads discovered item metadata live from the provider and does not
 * persist that metadata; only inbox state associated with provider items is persisted.
 */
export interface WorkCenterProvider {
  /** Stable unique identifier for this provider (e.g. `"github"`). */
  readonly id: string;
  /** Human-readable name shown in the UI. */
  readonly label: string;
  /**
   * When `true`, previously dismissed items are reset to unseen on the next
   * refresh, allowing them to reappear in the Inbox. Defaults to `false`.
   */
  readonly resurfaceDismissed?: boolean;
  /** Fires when the provider has a new or updated set of discovered items. */
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;
  /** Re-fetch items from the external source. */
  refresh(): Promise<void>;
}
