import type { CancellationTokenLike, DevDocketRunWatcher } from './runWatcher';
import type { DevDocketPRWatcher } from './prWatcher';
import type { Disposable, Event, ProviderItem } from './baseProvider';
import type { WorkItem, ActivityType } from './workItem';

/**
 * Rendered representation of an activity log entry's `detail` field,
 * returned by an {@link ActivityDetailRenderer}.
 *
 * The shape is plain JSON so it can be serialised across the webview
 * boundary.
 *
 * - `text` — a single string rendered verbatim where the raw detail
 *   would otherwise appear.
 * - `fields` — an ordered set of label/value rows rendered as a
 *   definition list. Use this for structured payloads that benefit
 *   from labelled per-field display.
 */
export type ActivityDetailRender =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'fields'; readonly rows: ReadonlyArray<{ readonly label: string; readonly value: string }> };

/**
 * Renders the `detail` payload of an activity log entry into a
 * display-ready representation. Called by the core extension when
 * serialising activity entries for the editor webview.
 *
 * Extensions that write structured `detail` payloads (e.g. JSON) own
 * the schema and should register a renderer so the core extension can
 * display the data without parsing the schema itself. Returning
 * `undefined` (or throwing) falls back to the default rendering, which
 * shows the raw `detail` string verbatim.
 */
export type ActivityDetailRenderer = (detail: string | undefined) => ActivityDetailRender | undefined;

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
 * Options that describe how a provider refresh was initiated.
 */
export interface ProviderRefreshOptions {
  /**
   * Whether the refresh was explicitly initiated by the user and may prompt
   * for authentication when a cached session is unavailable.
   */
  readonly interactive?: boolean;
}

/**
 * Options that describe how URL resolution was initiated.
 */
export interface ResolveUrlOptions {
  /**
   * Whether resolving the URL may prompt for authentication when a cached
   * session is unavailable. Background rehydration should pass `false`.
   */
  readonly interactive?: boolean;
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
  refresh(token?: CancellationTokenLike, options?: ProviderRefreshOptions): Promise<void>;
  /**
   * Optional minimum DevDocket API contract version (semver `major.minor.patch`)
   * this provider requires. The core extension compares this against
   * {@link DevDocketApi.contractVersion} when {@link DevDocketApi.registerProvider}
   * is called; if the core version is lower, registration is skipped (a warning
   * is logged and a no-op {@link Disposable} is returned) so the host extension
   * keeps working without the provider.
   *
   * Leave undefined to opt out of the check.
   */
  readonly minContractVersion?: string;
  /**
   * Attempt to resolve a URL into an item this provider can manage.
   *
   * Providers that support URL import should parse the URL and, if it
   * matches a pattern they own (e.g. a GitHub issue URL), fetch the
   * item details and return a {@link ProviderItem}. Return `undefined`
   * if the URL is not recognized by this provider.
   *
   * @param url - The raw URL entered by the user.
   * @param signal - Optional abort signal for cancellation.
   */
  resolveUrl?(url: string, signal?: AbortSignal, options?: ResolveUrlOptions): Promise<ProviderItem | undefined>;
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

/** Optional UI hints for how the core should surface a contextual action. */
export interface DevDocketActionPresentation {
  /**
   * Show this action as a dedicated button in the Incoming preview header when
   * it matches the synthetic post-accept work item shape.
   */
  readonly incomingPreview?: boolean;
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
  /** Optional hints for richer DevDocket surfaces beyond the Run Action picker. */
  readonly presentation?: DevDocketActionPresentation;
  /**
   * Optional minimum DevDocket API contract version (semver `major.minor.patch`)
   * this action requires. The core extension compares this against
   * {@link DevDocketApi.contractVersion} when {@link DevDocketApi.registerAction}
   * is called; if the core version is lower, registration is skipped (a warning
   * is logged and a no-op {@link Disposable} is returned).
   *
   * Leave undefined to opt out of the check.
   */
  readonly minContractVersion?: string;
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
 * `vscode.extensions.getExtension('devdocket.devdocket')`, then activating it
 * with `await extension.activate()` (or reading `extension.exports` after activation).
 *
 * > **Implementation note**: this interface is *implemented* only by the
 * > DevDocket core extension. Provider/action extensions and other
 * > third-party consumers should hold and call a `DevDocketApi` reference
 * > but must not implement the interface themselves. To keep additions
 * > structurally compatible with consumers that nevertheless do
 * > implement the interface (e.g. strict mocks or test wrappers), new
 * > members in `minor` releases of `@devdocket/shared` should be declared
 * > optional even when the core always populates them.
 *
 * @example
 * ```ts
 * const ext = vscode.extensions.getExtension<DevDocketApi>('devdocket.devdocket');
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
   * Semver string identifying the DevDocket extension API contract version
   * implemented by the core extension at runtime.
   *
   * Providers and actions may declare a {@link DevDocketProvider.minContractVersion}
   * (or {@link DevDocketAction.minContractVersion}); when the core's
   * `contractVersion` is lower, the corresponding `register*` call logs a
   * warning and returns a no-op {@link Disposable} instead of throwing,
   * letting the host extension degrade gracefully.
   *
   * Bumped according to semver: minor for additive changes, major for
   * breaking changes. See `docs/extension-api.md` for the bump policy.
   *
   * Optional only at the type level so that adding this member is a
   * non-breaking change for TypeScript consumers that structurally
   * implement {@link DevDocketApi} (e.g. test mocks). The DevDocket
   * core extension always sets it at runtime; an `undefined` value
   * therefore indicates an older core that predates this field.
   * Consumers calling the contract-version helpers in
   * `@devdocket/shared` (e.g. {@link isContractVersionSatisfied})
   * must guard against `undefined` themselves before passing the
   * value through — the helpers accept `string`, not `string | undefined`.
   */
  readonly contractVersion?: string;
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
   * Look up the live {@link ProviderItem} for a given (providerId, externalId)
   * pair. Returns `undefined` if the provider has not (yet) emitted a matching
   * item — for example because the provider is still loading or the item has
   * been removed upstream.
   *
   * Actions use this to read provider-supplied capabilities (e.g. {@link
   * ProviderItemCapabilities.gitWork}) when running against a {@link WorkItem}
   * that was previously accepted from this provider.
   *
   * @param providerId - The id of the provider that emitted the item.
   * @param externalId - The provider-scoped external id (e.g. `owner/repo#123`).
   */
  getProviderItem?(providerId: string, externalId: string): ProviderItem | undefined;
  /**
   * Register a pipeline run watcher.
   *
   * Run watchers provide status polling for CI/CD pipelines (GitHub Actions, ADO Pipelines, etc.).
   * Once registered, users can watch runs by pasting URLs into the "Watch URL" command.
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
   * @param detail - Optional human-readable detail string. DevDocket caps this
   *   value at 8 KiB (UTF-8) and truncates larger entries with `…[truncated]`.
   */
  addActivity?(itemId: string, type: ActivityType, detail?: string): Promise<void>;
  /**
   * Register a renderer that converts an activity log entry's raw
   * `detail` string into a display-ready representation.
   *
   * Extensions that write structured `detail` payloads (e.g. JSON
   * encoded by the writer) should register a renderer for their
   * activity types so the core extension can render entries without
   * having to understand the writer's schema. The core extension
   * always falls back to plain-text rendering of the raw `detail`
   * when no renderer is registered or the renderer returns
   * `undefined`.
   *
   * Only one renderer may be registered per activity type. Attempting
   * to register a second renderer for the same type throws.
   *
   * @param type - The activity type this renderer handles.
   * @param render - The rendering function.
   * @returns A {@link Disposable} that unregisters the renderer.
   */
  registerActivityDetailRenderer?(type: ActivityType, render: ActivityDetailRenderer): Disposable;
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
