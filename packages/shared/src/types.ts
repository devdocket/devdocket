/**
 * Provider-facing API types for WorkCenter extensions.
 *
 * These interfaces are structurally identical to the canonical definitions in
 * `packages/core/src/api/types.ts`. They are re-declared here so that provider
 * extensions can import them from `@workcenter/shared` instead of manually
 * re-declaring them in every file. Keep these in sync with core.
 */

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
 * Providers are registered via `WorkCenterApi.registerProvider` and emit
 * {@link DiscoveredItem}s through the {@link onDidDiscoverItems} event.
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
  refresh(token?: import('vscode').CancellationToken): Promise<void>;
}
