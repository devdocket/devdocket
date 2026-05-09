import type { CancellationTokenLike, DevDocketRunWatcher } from './runWatcher';
import type { DevDocketPRWatcher } from './prWatcher';
import type { Disposable, Event, ProviderItem, ResolvedItem } from './baseProvider';
import type { WorkItem, ActivityType } from './workItem';

/**
 * Event payload emitted when a work item changes lifecycle state.
 *
 * The {@link oldState} and {@link newState} fields are plain strings (e.g.
 * `'InProgress'`, `'Done'`), keeping satellite extensions decoupled from
 * the {@link WorkItemState} enum. The {@link item} snapshot retains the
 * enum-typed `state` property for consumers that need it.
 */
export interface StateTransitionEvent {
  /** ID of the work item that transitioned. */
  readonly itemId: string;
  /** Snapshot of the work item after the transition. */
  readonly item: Readonly<WorkItem>;
  /** Previous lifecycle state (e.g. `'InProgress'`). */
  readonly oldState: string;
  /** New lifecycle state (e.g. `'Done'`). */
  readonly newState: string;
}

/**
 * A provider that discovers work items from an external source.
 *
 * Providers are registered via {@link DevDocketApi.registerProvider} and emit
 * {@link ProviderItem} arrays when new items are found. The core extension
 * reads discovered item metadata live from the provider and does not persist it;
 * only inbox state is persisted.
 *
 * @example
 * ```ts
 * const emitter = new vscode.EventEmitter<ProviderItem[]>();
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
  readonly onDidDiscoverItems: Event<ProviderItem[]>;
  /**
   * Re-fetch items from the external source.
   * Implementations should fire {@link onDidDiscoverItems} with the results.
   *
   * VS Code extensions typically pass a `vscode.CancellationToken` which
   * structurally satisfies {@link CancellationTokenLike}.
   */
  refresh(token?: CancellationTokenLike): Promise<void>;
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
  /**
   * Check which of the given external items have been closed or completed.
   *
   * The core extension calls this after each provider refresh to auto-complete
   * linked work items — including manually-imported items that may not appear
   * in the provider's discovered-items list.
   *
   * @param externalIds - The provider-scoped external IDs to check.
   * @param signal - Optional abort signal for cancellation.
   * @returns The subset of `externalIds` that are closed, merged, or completed.
   */
  getClosedItems?(externalIds: string[], signal?: AbortSignal): Promise<string[]>;
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
 *   api.registerRunWatcher?.(myWatcher);
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
   * Register a pipeline run watcher.
   *
   * Run watchers provide status polling for CI/CD pipelines (GitHub Actions, ADO Pipelines, etc.).
   * Once registered, users can watch runs by pasting URLs into the "Watch Pipeline Run" command.
   *
   * @param watcher - The run watcher to register.
   * @returns A {@link Disposable} that unregisters the watcher when disposed.
   */
  registerRunWatcher?(watcher: DevDocketRunWatcher): Disposable;
  /**
   * Append an activity log entry to a work item.
   *
   * Extension-defined actions or satellite extensions can use this to record
   * significant events (e.g. branch creation, worktree cleanup) on a work item.
   *
   * @param itemId - The work item ID to log against.
   * @param type - The activity type discriminator.
   * @param detail - Optional human-readable detail string.
   */
  addActivity?(itemId: string, type: ActivityType, detail?: string): Promise<void>;
  /**
   * Register a PR watcher for tracking pull request pipelines.
   *
   * PR watchers resolve PR URLs to their associated pipeline runs,
   * enabling automatic tracking of all CI/CD runs for a pull request.
   *
   * @param watcher - The PR watcher to register.
   * @returns A {@link Disposable} that unregisters the watcher when disposed.
   */
  registerPRWatcher?(watcher: DevDocketPRWatcher): Disposable;
  /**
   * Event fired after a work item changes lifecycle state.
   *
   * Satellite extensions can subscribe to react to state transitions
   * (e.g., prompting for cleanup when an item moves to Done).
   */
  onDidTransitionState?: Event<StateTransitionEvent>;
}
