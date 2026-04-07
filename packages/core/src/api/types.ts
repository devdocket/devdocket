import type * as vscode from 'vscode';
import type { WorkItem } from '../models/workItem';

/**
 * A resource that can be released to free underlying handles or subscriptions.
 */
export interface Disposable {
  /** Release any resources held by this object. */
  dispose(): void;
}

/**
 * A typed event that listeners can subscribe to.
 *
 * @typeParam T - The payload type delivered to each listener.
 */
export interface Event<T> {
  /**
   * Subscribe to this event.
   *
   * @param listener - Callback invoked each time the event fires.
   * @returns A {@link Disposable} that removes the listener when disposed.
   */
  (listener: (e: T) => void): Disposable;
}

/**
 * An item discovered by a {@link WorkCenterProvider}.
 *
 * Discovered items are ephemeral references held in memory by the provider.
 * Only the inbox state (`unseen` | `accepted` | `dismissed`) is persisted;
 * the item's data is always read live from the provider.
 */
export interface DiscoveredItem {
  /** Provider-scoped unique identifier (e.g. a GitHub issue number). */
  externalId: string;
  /** Human-readable title displayed in the Inbox and Sources views. */
  title: string;
  /** Optional longer description of the item. */
  description?: string;
  /** Optional URL linking back to the item in its source system. */
  url?: string;
  /** Optional grouping key used to organize items in the UI (e.g. in the Inbox and Sources views). */
  group?: string;
}

/**
 * A provider that discovers work items from an external source.
 *
 * Providers are registered via {@link WorkCenterApi.registerProvider} and emit
 * {@link DiscoveredItem} arrays when new items are found. The core extension
 * reads discovered item metadata live from the provider and does not persist it;
 * only inbox state is persisted.
 *
 * @example
 * ```ts
 * const emitter = new vscode.EventEmitter<DiscoveredItem[]>();
 * const provider: WorkCenterProvider = {
 *   id: 'github',
 *   label: 'GitHub Issues',
 *   onDidDiscoverItems: emitter.event,
 *   async refresh() {
 *     const issues = await fetchIssues();
 *     emitter.fire(issues);
 *   },
 * };
 * api.registerProvider(provider);
 * ```
 */
export interface WorkCenterProvider {
  /** Unique identifier for this provider (e.g. `'github'`). */
  readonly id: string;
  /** Human-readable display name shown in the UI. */
  readonly label: string;
  /**
   * When `true`, previously dismissed items are reset to unseen on the next
   * refresh, allowing them to reappear in the Inbox. Defaults to `false`.
   */
  readonly resurfaceDismissed?: boolean;
  /** Event fired when the provider discovers or refreshes its item list. */
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;
  /**
   * Re-fetch items from the external source.
   * Implementations should fire {@link onDidDiscoverItems} with the results.
   */
  refresh(token?: vscode.CancellationToken): Promise<void>;
}

/**
 * A context-menu action that can be run against a {@link WorkItem}.
 *
 * Actions are registered via {@link WorkCenterApi.registerAction} and surfaced
 * dynamically — {@link canRun} is called to determine visibility.
 *
 * @example
 * ```ts
 * const action: WorkCenterAction = {
 *   id: 'start-work',
 *   label: 'Start Work',
 *   canRun: (item) => !!item.providerId,
 *   run: async (item) => { await createBranch(item); },
 * };
 * api.registerAction(action);
 * ```
 */
export interface WorkCenterAction {
  /** Unique identifier for this action (e.g. `'start-work'`). */
  readonly id: string;
  /** Label shown in the context menu. */
  readonly label: string;
  /**
   * Determine whether this action is applicable to the given work item.
   *
   * @param item - The work item to test.
   * @returns `true` if the action should be offered for this item.
   */
  canRun(item: WorkItem): boolean;
  /**
   * Execute the action against the given work item.
   *
   * @param item - The work item to act on.
   */
  run(item: WorkItem): Promise<void>;
}

/**
 * Public API surface of the WorkCenter extension.
 *
 * Obtain this API from the core extension by getting its extension wrapper via
 * `vscode.extensions.getExtension('mthalman.workcenter')`, then activating it
 * with `await extension.activate()` (or reading `extension.exports` after activation).
 *
 * @example
 * ```ts
 * const ext = vscode.extensions.getExtension<WorkCenterApi>('mthalman.workcenter');
 * const api = await ext?.activate();
 * if (api) {
 *   api.registerProvider(myProvider);
 *   api.registerAction(myAction);
 * }
 * ```
 */
export interface WorkCenterApi {
  /**
   * Register a work-item provider.
   *
   * The provider's initial refresh is triggered automatically after
   * registration (asynchronously), and its discovered items will appear
   * in the Inbox and Sources views.
   *
   * @param provider - The provider to register.
   * @returns A {@link Disposable} that unregisters the provider when disposed.
   */
  registerProvider(provider: WorkCenterProvider): Disposable;
  /**
   * Register a contextual action for work items.
   *
   * The action's {@link WorkCenterAction.canRun} method is evaluated per item
   * to determine whether it appears in context menus.
   *
   * @param action - The action to register.
   * @returns A {@link Disposable} that unregisters the action when disposed.
   */
  registerAction(action: WorkCenterAction): Disposable;
}
