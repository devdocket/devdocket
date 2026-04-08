import type { Event, DiscoveredItem } from './baseProvider';

/**
 * A provider that discovers work items from an external source (e.g. GitHub Issues).
 *
 * Providers are registered through the WorkCenter API and emit
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
