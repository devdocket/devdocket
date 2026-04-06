import { WorkItem } from '../models/workItem';
import type { Disposable, Event, DiscoveredItem } from '@workcenter/shared';

// Re-export shared provider-facing types so existing imports from './api/types' keep working.
export type { Disposable, Event, DiscoveredItem } from '@workcenter/shared';

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

/**
 * A context-menu action that can be run against a {@link WorkItem}.
 *
 * Actions are registered via {@link WorkCenterApi.registerAction} and surfaced
 * dynamically — {@link canRun} is called to determine visibility.
 */
export interface WorkCenterAction {
  /** Stable unique identifier for this action. */
  readonly id: string;
  /** Label shown in the context menu. */
  readonly label: string;
  /** Return `true` if this action is applicable to the given item. */
  canRun(item: WorkItem): boolean;
  /** Execute the action for the given item. */
  run(item: WorkItem): Promise<void>;
}

/**
 * Main entry point for provider extensions.
 *
 * Obtain this API from the core extension by first getting its extension
 * wrapper via `vscode.extensions.getExtension('mthalman.workcenter')`, then
 * activating it with `await extension.activate()` (or reading `extension.exports`
 * after activation). The core extension's `activate()` returns this API.
 */
export interface WorkCenterApi {
  /** Register a provider that discovers work items from an external source. */
  registerProvider(provider: WorkCenterProvider): Disposable;
  /** Register a context-menu action that operates on work items. */
  registerAction(action: WorkCenterAction): Disposable;
}
