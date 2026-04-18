import type * as vscode from 'vscode';
import { WorkItem } from '../models/workItem';
import type { Disposable, Event, DiscoveredItem, ResolvedItem } from '@devdocket/shared';

// Re-export shared provider-facing types so existing imports from './api/types' keep working.
export type { Disposable, Event, DiscoveredItem, ResolvedItem };

/**
 * A provider that discovers work items from an external source.
 *
 * Providers are registered via {@link DevDocketApi.registerProvider} and emit
 * {@link DiscoveredItem} arrays when new items are found. The core extension
 * reads discovered item metadata live from the provider and does not persist it;
 * only inbox state is persisted.
 *
 * @example
 * ```ts
 * const emitter = new vscode.EventEmitter<DiscoveredItem[]>();
 * const provider: DevDocketProvider = {
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
export interface DevDocketProvider {
  /** Unique identifier for this provider (e.g. `'github'`). */
  readonly id: string;
  /** Human-readable display name shown in the UI. */
  readonly label: string;
  /** Event fired when the provider discovers or refreshes its item list. */
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;
  /**
   * Re-fetch items from the external source.
   * Implementations should fire {@link onDidDiscoverItems} with the results.
   */
  refresh(token?: vscode.CancellationToken): Promise<void>;
  /**
   * Attempt to resolve a URL into an item this provider can manage.
   *
   * Providers that support URL import should parse the URL and, if it
   * matches a pattern they own (e.g. a GitHub issue URL), fetch the
   * item details and return a {@link ResolvedItem}. Return `undefined`
   * if the URL is not recognised by this provider.
   *
   * @param url - The raw URL entered by the user.
   * @param signal - Optional abort signal for cancellation.
   */
  resolveUrl?(url: string, signal?: AbortSignal): Promise<ResolvedItem | undefined>;
}

/**
 * A context-menu action that can be run against a {@link WorkItem}.
 *
 * Actions are registered via {@link DevDocketApi.registerAction} and surfaced
 * dynamically — {@link canRun} is called to determine visibility.
 *
 * ## Trust model
 *
 * Actions receive a **read-only view** of the work item (`Readonly<WorkItem>`).
 * This is a TypeScript type-level restriction only; it does not create a
 * runtime snapshot or frozen copy of the item. Third-party extensions should
 * treat the object as immutable and use the DevDocket API (e.g. VS Code
 * commands) rather than mutating the object.
 *
 * @example
 * ```ts
 * const action: DevDocketAction = {
 *   id: 'start-work',
 *   label: 'Start Work',
 *   canRun: (item) => !!item.providerId,
 *   run: async (item) => { await createBranch(item); },
 * };
 * api.registerAction(action);
 * ```
 */
export interface DevDocketAction {
  /** Unique identifier for this action (e.g. `'start-work'`). */
  readonly id: string;
  /** Label shown in the context menu. */
  readonly label: string;
  /**
   * Determine whether this action is applicable to the given work item.
   *
   * @param item - A read-only view of the work item to test.
   * @returns `true` if the action should be offered for this item.
   */
  canRun(item: Readonly<WorkItem>): boolean;
  /**
   * Execute the action against the given work item.
   *
   * @param item - A read-only view of the work item to act on.
   */
  run(item: Readonly<WorkItem>): Promise<void>;
}

/**
 * Payload for the {@link DevDocketApi.onDidTransitionState} event.
 *
 * Fired after a work item transitions between lifecycle states (e.g.
 * InProgress → Done). Extensions can subscribe to react to state changes.
 */
export interface StateTransitionEvent {
  /** The work item after the transition completed. */
  readonly item: Readonly<WorkItem>;
  /** The lifecycle state before the transition. */
  readonly oldState: string;
  /** The lifecycle state after the transition. */
  readonly newState: string;
}

/**
 * Public API surface of the DevDocket extension.
 *
 * Obtain this API from the core extension by getting its extension wrapper via
 * `vscode.extensions.getExtension('mthalman.devdocket')`, then activating it
 * with `await extension.activate()` (or reading `extension.exports` after activation).
 *
 * @example
 * ```ts
 * const ext = vscode.extensions.getExtension<DevDocketApi>('mthalman.devdocket');
 * const api = await ext?.activate();
 * if (api) {
 *   api.registerProvider(myProvider);
 *   api.registerAction(myAction);
 * }
 * ```
 */
export interface DevDocketApi {
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
  registerProvider(provider: DevDocketProvider): Disposable;
  /**
   * Register a contextual action for work items.
   *
   * The action's {@link DevDocketAction.canRun} method is evaluated per item
   * to determine whether it appears in context menus.
   *
   * @param action - The action to register.
   * @returns A {@link Disposable} that unregisters the action when disposed.
   */
  registerAction(action: DevDocketAction): Disposable;
  /**
   * Fires after a work item transitions to a new lifecycle state.
   *
   * Extensions can subscribe to this event to react when items move between
   * states (e.g. perform cleanup when an item is marked as Done).
   */
  readonly onDidTransitionState: Event<StateTransitionEvent>;
}
