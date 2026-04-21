# Fenster — Extension Dev — History

## Core Context

DevDocket is a VS Code extension monorepo for managing work items from multiple sources (GitHub issues, ADO work items, PRs). Packages: `core`, `github`, `ado`, `start-git-work`, `shared`, `ai-reviewer`.

### Architecture
- **Four-view model:** Inbox (unseen discovered items) → Queue (accepted WorkItems, state=New) → Focus (in-progress) → History (Done/Archived). Plus Sources view (hierarchical Provider → Group → Item tree).
- **6-state WorkItem model:** New, Triaged, InProgress, Paused, Done, Archived. History→Queue transitions (Done→New, Archived→New) are valid.
- **WorkGraph service:** In-memory `Map<string, WorkItem>`, event-driven, `ITaskStore` abstraction. `JsonTaskStore` uses write-queue serialization and in-memory cache as source of truth.
- **DiscoveredStateStore:** Persists `InboxState` (unseen/accepted/dismissed) as `discovered-state.json`. Dismissed items are sticky — never resurfaced by providers.
- **ProviderRegistry:** Tracks provider health (`ProviderHealthStatus`), fires `onDidChangeProviderHealth` events. `handleDiscoveredItems()` manages state transitions including version-based resurfacing for `accepted` items.
- **Event-driven updates:** Mutate → save → fire pattern. EventEmitters drive UI tree refreshes.

### Key File Paths
- `packages/core/src/services/workGraph.ts` — core service (createItem, updateItem, transitionState, deleteItem, clearOldHistory)
- `packages/core/src/services/providerRegistry.ts` — provider management, health tracking, discovered items
- `packages/core/src/storage/jsonTaskStore.ts` — persistence (implements ITaskStore)
- `packages/core/src/storage/discoveredStateStore.ts` — InboxState persistence + change events
- `packages/core/src/views/` — inboxTreeProvider, queueTreeProvider, focusTreeProvider, historyTreeProvider, sourcesTreeProvider, viewLayout.ts, editorPanelHtml.ts, workItemEditorPanel.ts
- `packages/core/src/commands/commands.ts` — all command registrations
- `packages/core/src/extension.ts` — activation entry point, context key init
- `packages/core/package.json` — contributes views, commands, menus, config
- `packages/ai-reviewer/src/basePrAction.ts` — shared PR action logic
- `packages/ai-reviewer/src/aiReviewAction.ts` — code review action (extends BasePrAction)
- `packages/ai-reviewer/src/aiWalkthroughAction.ts` — walkthrough action
- `packages/ai-reviewer/src/walkthroughParticipant.ts` — @walkthrough chat participant
- `packages/github/src/githubProvider.ts` — GitHub issues REST API
- `packages/ado/src/adoWorkItemProvider.ts` — ADO work items with state-category filtering

### Established Patterns
- **Storage write serialization:** `writeQueue: Promise<void>` chain prevents concurrent file corruption.
- **In-memory cache:** `Map<string, WorkItem>` as source of truth; disk is persistence only. Clone before mutating (`{ ...item, ...patch }`).
- **Provider items as references:** `discovered-state.json` persists lightweight state only. Item data lives in ProviderRegistry's in-memory cache.
- **Git operation safety:** Check branch existence, directory existence, rollback on failure. Use `path.join()` for cross-platform paths. Auth via `GIT_CONFIG_COUNT`/`KEY`/`VALUE` env vars (never `-c http.extraheader` CLI args).
- **Stable external IDs:** `owner/repo#number` format. URL-imported items use `providerId: 'url-import'`.
- **Webview security:** CSP `default-src 'none'`. `escapeHtml()` for text, `escapeAttr()` for attributes. External links via `postMessage` + `isSafeUrl()`.
- **Markdown injection prevention:** `appendText()` for user-controlled strings, not `appendMarkdown()`.
- **Prompt injection prevention:** Sanitize URLs via `new URL(url)` + strip control chars before LLM prompt interpolation. `baseRef` validated with strict allowlist `/^[a-zA-Z0-9._\/-]+$/` before interpolation into LLM prompts (#331).
- **Plugin API trust boundary:** Log registrations, reject duplicate IDs, enforce `MAX_ITEMS_PER_PROVIDER` at ingestion.
- **Custom prompt path validation:** All paths contained within workspace folder via `path.normalize()` + prefix comparison.
- **JSON validation:** Validate parsed JSON at runtime. `MAX_STORE_FILE_SIZE` in `limits.ts`. Backup-and-reset on corruption.
- **BasePrAction extraction:** Shared PR action logic. Subclasses provide ~25 lines instead of ~240.
- **ADO state-category filtering:** Two-layer: WIQL excludes `Closed`/`Removed`, states API filters by category. Fail-open pattern.
- **Tree node counts:** Parent nodes show `(N)` child counts. Unhealthy providers show "refresh failed" instead.
- **buildDescription():** Filters undefined values. Layout-aware descriptions across all views.
- **Version-based resurfacing:** Optional `version` on `DiscoveredItem`. Change on `accepted` resets to `unseen`. Dismissed never resurfaced.
- **Layout toggle:** Two command IDs per toggle with own icons. Context keys set on activation + config listener.
- **Build:** esbuild, CJS, `--external:vscode`, sourcemaps. Root `npm install` + `npm run build`.

### Completed Issues
#333 (storage write-queue consolidation), #302 (consolidate shared types), #330 (git auth env vars — credential exposure fix), #299 (fix double disposal), #323 (watch CI pipelines), #322 (auto-complete activity log), #320 (focus view grouping), #282 (provider state in editor), #281 (clickable title), #276 (auto-track authored PRs), #275 (History→Queue transitions), #273 (tree counts), #265 (auto-complete on close), #255 (provider metadata docs), #250 (group context), #249 (accept-to-focus, pre-shipped), #243 (version resurfacing), #240 (create from URL), #233 (provider health), #232 (clear history), #231 (sources icons), #230 (layout toggle), #229 (emoji removal), #227 (provider labels), #223 (dead code cleanup), #222 (responsive layout), #221 (contextual heading), #219 (source URL link), #217 (editor metadata), #216 (provider description), #215 (dynamic titles), #189 (dismissed fix), #178 (ADO filtering), #158 (markdown injection), #157 (API trust boundary), #156 (URL sanitization), #155 (URL scheme validation), #154 (crypto.randomUUID), #153 (JSON validation), #152 (path traversal fix), #12 (AI PR actions), bulk rename (WorkCenter→DevDocket)

> **Archived Summary (04-17 and earlier):** Early issues including auto-complete v1 with disappearance detection (#265), large PR fix for walkthrough (#261), clickable title (#281), item activity log (#260), AI model selection (#254), keyboard shortcuts (#226), and dynamic title sync via `titleSync.ts` service (#215). Full learnings in `history-archive.md`

## Learnings

### 2026-04-23 — Issue #302 (Consolidate duplicated type declarations into shared)

**Refactor:** Moved all duplicated type declarations (`WorkItem`, `WorkItemState`, `DevDocketAction`, `DevDocketProvider`, `DevDocketApi`, `ActivityLogEntry`, `ActivityType`, `StateTransitionEvent`) to `@devdocket/shared`. Satellite extensions now import from a single source of truth.
- **Problem:** Every consumer package (ai-reviewer, start-git-work, github) re-declared core API types locally. The ai-reviewer copy was already stale (`description` vs `notes`, missing fields).
- **New shared files:** `packages/shared/src/workItem.ts` (WorkItem, WorkItemState, WorkItemInput, ActivityLogEntry, ActivityType), `packages/shared/src/apiTypes.ts` (DevDocketProvider, DevDocketAction, DevDocketApi, StateTransitionEvent).
- **Re-export pattern:** Core's `models/workItem.ts`, `models/activityLog.ts`, and `api/types.ts` now re-export from `@devdocket/shared` — all existing intra-core imports remain unchanged.
- **CancellationToken handling:** `DevDocketProvider.refresh(token?: CancellationTokenLike)` uses the shared `CancellationTokenLike` interface instead of `vscode.CancellationToken`. This avoids a vscode dependency in shared while remaining structurally compatible — `vscode.CancellationToken` satisfies `CancellationTokenLike`. Implementations can still declare `vscode.CancellationToken` thanks to TypeScript's method bivariance.
- **Key lesson:** When moving types to a shared package that must remain vscode-free, use minimal interfaces (`CancellationTokenLike`) for vscode types. Callers pass the full vscode type which satisfies the minimal interface structurally. This is the same pattern used by `DevDocketRunWatcher.getRunStatus`.
- **Files changed:** `packages/shared/src/workItem.ts` (new), `packages/shared/src/apiTypes.ts` (new), `packages/shared/src/index.ts`, `packages/core/src/models/workItem.ts`, `packages/core/src/models/activityLog.ts`, `packages/core/src/api/types.ts`, `packages/ai-reviewer/src/types.ts`, `packages/ai-reviewer/package.json`, `packages/start-git-work/src/startWorkAction.ts`, `packages/start-git-work/src/gitCleanup.ts`, `packages/start-git-work/src/extension.ts`, `packages/github/src/baseGithubProvider.ts`.
## Learnings

### 2026-04-23 — Issue #335 (Extract shared tree view utilities)

**Refactor:** Extracted duplicated tooltip-building and icon-resolution logic from Focus, History, and Queue tree providers into shared `viewUtils.ts`.
- **`buildWorkItemTooltip(item, title, options?)`:** Unified tooltip builder with configurable `showState`, `timestamp` field, `timestampLabel`, and `notesStyle` options. Replaces three near-identical private `buildTooltip` methods.
- **`getWorkItemIcon(state)`:** Single icon-resolution function covering all `WorkItemState` values. Replaces separate `getIcon` methods in Focus and History providers.
- **`LayoutState` adoption:** Refactored `WatchesTreeProvider` to use the existing `LayoutState` class from `viewLayout.ts` instead of inline layout management.
- **Test update:** History's "unexpected state" test now expects `play-circle` (the correct mapped icon for InProgress) instead of `circle-outline` (former default fallthrough).
- **Files changed:** `viewUtils.ts` (new), `focusTreeProvider.ts`, `historyTreeProvider.ts`, `queueTreeProvider.ts`, `watchesTreeProvider.ts`, `viewUtils.test.ts` (new, 12 tests).
- **Pattern:** When extracting shared view utilities, use options objects (not method overloading) to handle per-view differences in tooltip/icon behavior.

### 2026-04-23 — Issue #333 (Consolidate storage write-queue and validation patterns)

**Refactor:** Extracted `SerializedJsonStore` base class and composable field validators to eliminate duplicated plumbing across 5 store classes.
- **Problem:** All 5 stores in `packages/core/src/storage/` independently implemented write-queue serialization (`writeQueue` + `enqueue()`), JSON read/write helpers (stat, size check, parse, backup), and hand-rolled `typeof` validation checks (80+ lines across stores).
- **Solution:** Created `SerializedJsonStore` abstract base class (`serializedJsonStore.ts`) with `enqueue()`, `readJson()`, `writeJson()`, `backupFile()`, and `flush()`. Created `validation.ts` with composable validators: `validateObject`, `requiredString`, `optionalString`, `requiredEnum`, `requiredFiniteNumber`, `optionalFiniteNumber`. All 5 stores now extend the base class.
- **Stores refactored:** `JsonTaskStore`, `DiscoveredStateStore`, `ReadStateStore`, `ProviderLabelCache`, `WatchStore`. Each removed its own write-queue, backup, and writeFile/readFile boilerplate. Validation functions now use `??` chains of composable validators instead of sequential `typeof` checks.
- **Test impact:** 7 tests in `discoveredStateStore.test.ts` that spied on `store.writeFile` updated to spy on `store.writeJson` (the base class method). All 154 storage tests pass.
- **Pattern:** When multiple stores share write serialization, extract a `SerializedJsonStore` base class. Stores override their load/save logic but delegate enqueue, JSON I/O, and backup to the base. Validation uses composable functions composed with `??`.

### 2026-04-23 — Issue #305 (Split commands.ts into domain modules)

**Refactoring:** Split the 1118-line monolith `commands.ts` into 8 domain-specific modules plus a shared utilities file.
- **Modules created:** `commandUtils.ts` (shared helpers), `inboxCommands.ts`, `queueCommands.ts`, `focusCommands.ts`, `historyCommands.ts`, `layoutCommands.ts`, `generalCommands.ts`, `sourcesCommands.ts`, `watchCommands.ts`.
- **Pattern:** Each module exports a single `register*Commands()` function that receives only the dependencies it needs. The original `commands.ts` becomes a thin orchestrator calling each domain registrar.
- **Shared utilities in `commandUtils.ts`:** `wrapCommand`, `handleCommandError`, `resolveItemIds`, `formatItemTitle`, `batchTransition`, `batchAcceptItems` + `AcceptableItem` interface — used across multiple domain modules.
- **Key lesson:** When splitting a monolith, identify cross-cutting helpers first and extract them into a shared utils module. Domain-specific type guards (e.g., `isInboxItem`, `isSourceItem`) stay in their respective domain modules since they're only used there.
- **Files changed:** 9 new files in `packages/core/src/commands/`, `commands.ts` reduced to ~40 lines.

### 2026-04-22 — Issue #306 (Scope WorkItemEditorPanel cache to extension lifecycle)

**Refactor:** Moved the static panel cache from `WorkItemEditorPanel` to a `PanelManager` class instantiated during `activate()` and disposed with the extension context.
- **Problem:** Static `Map<string, WorkItemEditorPanel>` survived extension reloads during development, leaking stale panel references. `clearPanelCache()` existed but was only called in tests.
- **Solution:** Created `PanelManager` class owning the `openPanels` map. Each `activate()` creates a fresh `PanelManager`, sets it via `WorkItemEditorPanel.setPanelManager()`, and pushes it to `context.subscriptions`. On deactivation, `PanelManager.dispose()` clears all panels.
- **Backward compatibility:** Kept static `open()` and `clearPanelCache()` on `WorkItemEditorPanel` as thin delegates to the current manager. Tests work unchanged — they use the default static manager reset by `clearPanelCache()` in `beforeEach`.
- **Pattern:** When static class state needs lifecycle scoping, use a manager class with `setPanelManager()` injection — preserves static API facade for consumers while scoping ownership to `activate()`/`deactivate()`.
- **Files changed:** `packages/core/src/views/workItemEditorPanel.ts` (new `PanelManager` class, refactored panel cache ownership), `packages/core/src/extension.ts` (create + register `PanelManager`).

### 2026-04-22 — Issue #300(CancellationToken → AbortSignal wiring)

**Bug fix:** Providers accepted `CancellationToken` in `refresh()` but only checked `isCancellationRequested` at discrete points. In-flight `fetch()` calls ran to completion even after cancellation.
- **Pattern:** Create `AbortController` at refresh entry point, wire `token?.onCancellationRequested?.(() => abortController.abort())` with double optional chaining (test mocks may lack the event method), pass `abortController.signal` to all `fetch()` calls down the chain.
- **Signal combining:** Use `combineSignals(signal, 30_000)` from `@devdocket/shared` to merge cancellation + per-request timeout into one signal. Node 18 compatible — `AbortSignal.any()` requires Node 20.3+ which isn't available in VS Code 1.85.0's runtime.
- **AbortError handling:** Catch `AbortError` (check `err.name === 'AbortError'`) at the top-level and log at debug level, not error. Guard rethrows with `&& signal?.aborted` to distinguish cancellation from timeouts (`TimeoutError`).
- **Worker pool abort:** Throw `AbortError` (not break) at top of worker loops when `signal?.aborted` — ensures cancellation propagates through `Promise.all` and prevents partial result publishing. For `Promise.allSettled`, check for AbortError in results after settling and rethrow before publishing.
- **Files changed:** `shared/src/signalUtils.ts` (new — `combineSignals`), `baseGithubProvider.ts` (core wiring), `githubProvider.ts`, `githubPrReviewProvider.ts`, `githubMyPrsProvider.ts`, `adoWorkItemProvider.ts`, `adoPrReviewProvider.ts`, `adoPipelineWatcher.ts`.
- **Key lesson:** `?.` on `token?.onCancellationRequested(...)` only guards against `token` being nullish. If `token` exists but lacks `onCancellationRequested` (like test mocks), it throws. Must use `token?.onCancellationRequested?.(...)` with double optional chaining.
### 2026-04-21 — README Refresh

**Task:** Rewrote README per Matt's requests — removed marketplace install language, trimmed config details, added build-from-source instructions.
- **Key changes:** Replaced "Quick Start" (marketplace-based) with "Installation" (clone/build/F5/vsce). Condensed five-view descriptions from multi-paragraph sections to a summary table. Removed inline GitHub provider and Start Git Work config blocks. Removed auto-completion config block. Removed Data Storage section (implementation detail).
- **Moved to UX guide:** Auto-completion behavior + `autoCompleteOnClose` setting, Start Git Work `commands` configuration with `{path}` placeholder docs, added `autoCompleteOnClose` to Core Configuration table.
- **Pattern:** README = welcoming overview + install + pointers to docs. UX guide = detailed behavior, config tables, keyboard shortcuts. Keep README under ~120 lines.
### 2026-04-22 — Issue #298 (Add fetch/git timeouts)

**Bug fix:** Added timeout safety nets to all unprotected `fetch()` and `execFile`/`execFileAsync` calls across the extension.
- **Fetch timeouts:** `AbortSignal.timeout(30_000)` added to 19 fetch() calls across github, ado, ai-reviewer packages that previously had no signal. Calls already receiving an `AbortSignal` from callers (e.g., `getClosedItems`, `resolveUrl`) left unchanged.
- **Git subprocess timeouts:** `timeout: 30_000` added to all local git operations (`branch`, `show-ref`, `worktree add/remove`, `reset`). Network git ops (`clone`, `fetch`) use `timeout: 300_000` (5 min) since they involve data transfer.
- **gitExec signature change:** Added optional `timeout` parameter (default 30_000) to `packages/ai-reviewer/src/tools/gitUtils.ts`. `gitAuth` wrapper in `repoManager.ts` passes through. Non-breaking: existing callers get the default.
- **User-configured commands:** `startWorkAction.ts` post-worktree commands get `timeout: 60_000` (longer than git ops since arbitrary user commands may need more time).
- **Files changed:** 12 source files + 1 test file across github, ado, ai-reviewer, start-git-work packages.
- **Related:** #300 (CancellationToken→AbortController wiring) is a separate issue for deeper cancellation integration.

### 2026-04-21 — Issue #323 (Watch CI Pipelines — PR #323)

**Feature:** Full CI pipeline watcher with ADO support, polling control, tree/flat layout toggle, and persistence.
- **Core components:** `WatcherService` (lifecycle/polling), `WatchStore` (persistence via write-queue), `WatchesTreeProvider` (tree/flat views), ADO pipeline watcher (status polling).
- **Watch model:** `{ id, providerId, externalId, repoId?, runId?, state, lastChecked, dismissedAt? }`. Persisted to `globalStorageUri` alongside other stores.
- **Layout toggle:** Two command IDs (tree/flat) with context keys, mirrors pattern from history layout toggle.
- **Polling interval:** 60s default, configurable via `devdocket.watchPollingInterval` setting.
- **Dismissal:** Per-watch via activity-log-style dismissal. Multiple Copilot review rounds refined error handling, edge cases, layout logic.
- **Context-menu-only browser open:** "Open in browser" only appears in context menu (not tree click), prevents accidental external navigation.
- **Files changed:** `packages/core/src/services/watcherService.ts` (new), `packages/core/src/storage/watchStore.ts` (new), `packages/core/src/views/watchesTreeProvider.ts` (new), `packages/ado/src/adoPipelineWatcher.ts` (new), plus tests, views, and commands.
- **Extensibility:** Architecture ready for GitHub Actions watcher via future provider.

### 2026-04-21 — Issue #321 (Worktree Cleanup on Complete — PR #321)

**Major refactor:** Activity-log-driven metadata, moved gitCleanup from core to start-git-work, ActivityType derived from ACTIVITY_TYPES array.
- **Design principle:** Branch/worktree metadata lives in `'work-started'` activity log entry (JSON detail), not on WorkItem fields. Implements team directive: "derive data from activity log when possible".
- **Three new activity types:** `'work-started'`, `'cleanup'`, `'cleanup-dismissed'`. Breaking change but documented in PR migration notes.
- **Dismissal semantic:** `'cleanup-dismissed'` entry prevents re-prompting until a new `'work-started'` entry. Temporal ordering in log naturally handles re-arming.
- **Non-blocking transition:** State transition succeeds immediately; cleanup prompt fires async. Prevents workflow interruption.
- **Git safety:** `git branch -d` (not `-D`) warns on unmerged changes. `--` terminators on all commands. `git show-ref --verify` for exact checks. Async `fs.promises.access` for directory validation.
- **Files changed:** `packages/core/src/models/activityLog.ts`, `workItem.ts`, `gitCleanup.ts` (moved to start-git-work), `workGraph.ts`, `commands.ts`, `package.json`, `jsonTaskStore.ts`; `packages/start-git-work/src/startWorkAction.ts`.
- **Consequence:** Cleaner WorkItem model. Activity log as audit trail. Couples with issue #264 decision in decisions.md.

### 2026-04-21 — Issue #320 (Focus View Provider Grouping — PR #320)

**Bug fix:** Sub-group count accuracy and provider ID normalization caching.
- **Sub-group count bug:** Parent node showed filtered child count instead of unfiltered count. Fixed by separating count calculation from filter logic.
- **Caching pattern:** `normalizeProviderId()` results cached at tree provider instantiation to avoid repeated normalization during refresh cycles. Small but significant performance win.
- **No API surface changes.** Isolated to `FocusTreeProvider` structure.

### 2026-04-20 — Issue #303 (Refactor BaseGitHubProvider to extend BaseProvider — PR #339)

**Refactor:** Unified provider base class by having `BaseGitHubProvider` extend `BaseProvider` from `@devdocket/shared`.
- **Problem:** Duplicate health tracking, event emission logic lived in both `BaseProvider` and `BaseGitHubProvider`.
- **Solution:** Removed 77 lines of duplication. GitHub provider now extends shared base class while maintaining backward compatibility.
- **Result:** All 1750 tests pass. Event-driven architecture unified across all providers. Non-breaking change — no API surface modifications.
- **Pattern:** Share provider lifecycle patterns via `@devdocket/shared`. Extension-specific providers inherit core behavior.

### 2026-04-20 — Issue #305 (Split commands.ts monolith into domain modules — PR #341)

**Refactor:** Decomposed `packages/core/src/commands/commands.ts` into 8 focused domain modules.
- **Modules created:** `workItemLifecycle.ts`, `focusCommands.ts`, `queueCommands.ts`, `sourceCommands.ts`, `editorCommands.ts`, `layoutCommands.ts`, `providerCommands.ts`, `utilityCommands.ts`.
- **Pattern:** Each module groups 1-2 cohesive command families. Entry point (`commands.ts`) exports barrel or re-exports individual modules. Command registration order preserved.
- **Result:** 1166 lines organized by domain. All tests pass. No command ID changes — fully backward compatible.
- **Lesson:** Large monoliths benefit from domain-driven decomposition even before architectural changes. Breaks up cognitive load for reviewers.

### 2026-04-20 — Issue #306 (Scope WorkItemEditorPanel cache to extension lifecycle — PR #340)

**Refactor:** Introduced `PanelManager` class to scope panel cache lifecycle and prevent stale references.
- **Problem:** Static `Map<string, WorkItemEditorPanel>` survived extension reloads during development, leaking panel references. `clearPanelCache()` existed but only called in tests.
- **Solution:** Created `PanelManager` owned by `activate()` context. Each extension reload creates fresh manager. All panel creation flows through manager. On deactivation, `PanelManager.dispose()` clears panels.
- **Backward compat:** Static `open()` and `clearPanelCache()` delegate to current manager. Existing code unchanged.
- **Result:** 426 tests pass. Panel reuse works across cycles. Proper cleanup on deactivation. Zero memory leak.
- **Pattern:** Use manager class with dependency injection to scope static class state to extension lifecycle. Preserves static API facade while fixing ownership.
- **Files changed:** `packages/core/src/views/focusTreeProvider.ts`.

### 2026-04-21 — Auto-complete activity log integration (PR #322)

**Fix:** Auto-complete transitions to Done now log an `'auto-completed'` activity entry with detail like "Provider detected external closure (InProgress → Done)".
- **Pattern:** `transitionState()` already logs `'state-changed'`; the new `addActivity()` call adds a second entry distinguishing automatic from manual transitions.
- **ActivityType extension:** Added `'auto-completed'` to the string union. Store validator accepts any non-empty string, so no migration needed.
- **Three files changed:** `activityLog.ts` (type union), `autoComplete.ts` (addActivity call), `editorPanelHtml.ts` (display label).

### 2026-04-21 — Issue #255 (Provider Metadata Docs)

**PR:** Created `docs/provider-discovery.md` documenting what causes items to appear in each provider.
- **GitHub Issues:** Assigned to you + open + not a PR. Optionally scoped by `devdocketGithub.repos`.
- **GitHub PR Reviews:** Review requested from you + open. Supports two resurfacing signals (new commits, re-requested review).
- **ADO Work Items:** Assigned to you + not in terminal state category. Two-layer filtering: WIQL excludes `Closed`/`Removed`, then State Category API excludes Completed/Removed/Resolved categories.
- **ADO PR Reviews:** You are a reviewer + active status. Resurfacing via `lastMergeSourceCommit.commitId`.
- **Common behavior:** 5-min default refresh, 60s minimum, version-based resurfacing, dismissed items never resurface.
- **Documentation-only change** — no code modified, all tests pass.
### 2026-04-19 — Issue #276 (Auto-Track Authored PRs)

**PR:** Added a new `GitHubMyPrsProvider` that discovers open PRs authored by the current user and shows their review/CI status.
- **New provider pattern:** Follows `BaseGitHubProvider` extension pattern like the existing issue and PR review providers. Registered as third provider in `extension.ts`. Uses the same `devdocketGithub.repos` config for repo filtering.
- **Status determination:** Static `determinePrStatus()` method computes status from PR detail + reviews. Priority: Draft > Changes requested > Ready to merge (approved + clean) > Approved (approved but not clean) > Review received (comments only) > Waiting on reviews.
- **Review decision logic:** Tracks latest review per reviewer by `user.id`. Only `APPROVED` and `CHANGES_REQUESTED` count as decisions; `COMMENTED`, `PENDING`, `DISMISSED` are informational. Uses `submitted_at` timestamp comparison for ordering.
- **Mergeable state as CI proxy:** Uses `mergeable_state === 'clean'` from the PR detail API to determine "Ready to merge" status. This combines CI status and branch protection checks without requiring separate `/commits/{sha}/status` and `/check-runs` API calls — reduces per-PR API calls from 4 to 2.
- **Concurrent enrichment:** Fetches PR details and reviews in parallel per-PR with 3 concurrent workers (same pattern as PR review provider's head SHA fetching). Best-effort: failures fall back to generic "Open" status.
- **Test mock pattern:** Concurrent worker tests need URL-based mock routing (`mockImplementation` with URL matching) instead of sequential `mockResolvedValueOnce`, since worker execution order is non-deterministic.
- **No version-based resurfacing:** Status changes don't trigger resurfacing — status is informational via `DiscoveredItem.state`. Users track open PRs at a glance; merged PRs disappear and auto-complete (#265) handles the work item transition.
- **Files changed:** `packages/github/src/githubMyPrsProvider.ts` (new), `packages/github/src/extension.ts`, `packages/github/package.json`, `packages/github/src/test/githubMyPrsProvider.test.ts` (new, 24 tests).

### 2026-04-18 — Issue #264 (Cleanup Branch/Worktree on Complete)

**PR #321:** Prompt to clean up branch/worktree when completing a work item.
- **Activity-log-based tracking:** Instead of persisting branch/worktree metadata as WorkItem fields, the activity log is the source of truth. `StartWorkAction` logs a `'work-started'` entry with JSON detail containing `{ branchName, worktreePath, repoPath }`. `gitCleanup.ts` reads the most recent `work-started` entry to find cleanup targets.
- **Dismissal tracking:** When the user clicks "No" on the cleanup prompt, a `'cleanup-dismissed'` activity entry is logged. Subsequent Done transitions check for this entry after the last `work-started` to skip re-prompting. Esc/close does not persist dismissal — allows re-prompting later.
- **Activity types added:** `'work-started'`, `'cleanup'`, `'cleanup-dismissed'` added to `ActivityType` union. Breaking change documented in PR migration notes.
- **Command:** `devdocket.addActivity` command registered for extensions to log activities via `vscode.commands.executeCommand`. Validates type against known `ActivityType` values. Errors propagate to callers (no wrapCommand).
- **Cleanup safety:** `git branch -d` (not `-D`) warns about unmerged changes. `--` terminators on all git commands. `git show-ref --verify` for exact branch existence check. Async `fs.promises.access` instead of synchronous `existsSync`. `.git` directory validated before any checks.
- **Files changed:** `packages/core/src/models/activityLog.ts`, `workItem.ts`, `gitCleanup.ts` (new), `workGraph.ts`, `commands.ts`, `package.json`, `jsonTaskStore.ts`; `packages/start-git-work/src/startWorkAction.ts`; tests in core.

### 2026-04-18 — Issue #232 (History View Cleanup)

**PR #309:** Added history cleanup commands and auto-pruning to prevent unbounded growth.
- **Three new capabilities:** `clearAllHistory()` (delete all Done/Archived), `pruneHistory(maxItems)` (trim to N most recent), and `devdocket.maxHistoryItems` setting for automatic pruning.
- **Auto-prune wiring:** Scoped `autoTrimHistory` inside `activate()` to avoid stale refs across extension restarts. Debounced via 2s `setTimeout` to avoid scanning on every graph mutation. Re-entrancy guard prevents feedback loops from `onDidChange`.
- **Config change listener:** `onDidChangeConfiguration` routes `maxHistoryItems` changes through the debounce, applying limits when the user changes the setting.
- **Copilot review findings addressed:** Missing activation event for `clearAllHistory`, config value normalization via `Number()` + `isFinite`, error handling in debounced timer callback.
- **Files changed:** `workGraph.ts`, `extension.ts`, `commands.ts`, `package.json`, `workGraph.test.ts`, `commands.test.ts`

### 2026-04-18 — Issue #265 Redesign (Auto-Complete on External Close/Merge)

**PR #297 (redesigned):** Scan WorkGraph after provider refresh to auto-complete ALL linked work items — not just provider-discovered ones.
- **Redesign reason:** Matt rejected the disappearance-detection-only approach because it couldn't handle imported work items whose linked issues aren't tracked by any provider.
- **Two-tier approach:** (1) If provider implements optional `getClosedItems(externalIds, signal?)`, batch-check all linked work items including imports. (2) Fallback: disappearance detection (was previously discovered, now absent) for providers without `getClosedItems`.
- **Extracted service:** `autoComplete.ts` exports `checkAutoComplete()` and `showAutoCompleteNotification()` — injectable dependencies for testability.
- **API addition:** Optional `getClosedItems?` on `DevDocketProvider` with `AbortSignal` support. Non-breaking.
- **New event:** `onDidRefreshProvider(providerId)` replaces `onDidDetectCompletedItems`. Fires after each provider discovery, letting extension.ts run WorkGraph-scoped checks.
- **Previous-ID tracking:** `previousDiscoveredIds` map always updated (even on empty refresh) to prevent stale snapshots.
- **Copilot review fixes:** (1) Stale snapshot on empty refresh. (2) Deduplicate externalIds before getClosedItems. (3) AbortSignal on getClosedItems.
- **Files changed:** `types.ts`, `providerRegistry.ts`, `autoComplete.ts` (new), `extension.ts`, `workGraph.ts`, `workItem.ts`, `package.json`, `workGraph.test.ts`

## Learnings

### 2026-04-20 — Security & Concurrency Sprint

**Team outcome:** 5 PRs completed in parallel coordination with Hockney.

- **PR #327 — CancellationToken Race Condition Fix:** Fixed race condition in `combineSignals()` where concurrent updates corrupted state. Resolved all code review feedback in single cycle.
- **PR #328 — README Refresh:** Rewritten documentation with UX guide creation. Mermaid diagram removed. Merge conflicts resolved cleanly.
- **PR #330 — Credential Exposure Security Fix:** Moved git authentication from CLI arguments to `GIT_CONFIG` environment variables. Unified gitExec signature. 7-round review cycle completed.
- **PR #331 — BaseRef Sanitization Hardening:** Replaced weak denylist with strict `isValidRef()` allowlist validation. Only valid git refs accepted. 3-round review cycle completed.

**Hockney's contribution:** 44 new tests across 5 files covering AbortSignal wiring and cancellation paths (PR #329, 1942 tests passing).

**Key patterns emerged:**
- Environment variable patterns for sensitive data (applicable to future credential management).
- Allowlist validation more secure than denylist (applicable to all input validation).
- Concurrent signal handling requires careful synchronization (document in concurrency guidelines).

## Squad Triage & Routing (2026-04-20)

### Triage Round — 12 Untriaged Squad Issues

**Status:** COMPLETE — Keaton triaged all 12 untriaged issues via background agent.

**Routed to Fenster:** 8 issues
- **Bugs:** #298, #299, #300
- **Chores:** #301, #302, #303, #305, #306
- **Rationale:** Fenster owns provider implementations and provider API surface; bugs/chores align with existing focus areas

**Deferred to Keaton:** 4 issues
- **Architecture/Scope Decisions:** #292, #304, #307, #308
- **Rationale:** Require lead judgment on scope, priority trade-offs, or architectural direction. Pending design review.

See `.squad/orchestration-log/2026-04-20T16-18-00Z-keaton.md` for full triage details.

**PR #314:** Shared RepoManager and walkthrough findings between AI Code Review and AI Walkthrough.
- **Shared RepoManager pattern:** Single `RepoManager` instance in `extension.ts` passed to both `AiReviewAction` and `AiWalkthroughAction`. When code review runs for a PR that walkthrough already prepared, it reuses the existing clone/worktree.
- **Tool-enabled code review:** `AiReviewAction` now overrides `run()` and implements `analyzeWithTools()` with a tool-use loop (matching `WalkthroughParticipant` pattern). Model gets access to `devdocket-readFile`, `devdocket-searchCode`, etc. for full repo exploration during review. Falls back to diff-only `analyzeWithAi()` if worktree preparation fails.
- **WalkthroughCache for cross-action context:** New `WalkthroughCache` (Map-based, keyed by normalized PR URL) stores walkthrough findings. `WalkthroughParticipant` writes via `appendFindings()` each iteration. `AiReviewAction` reads and includes in the review prompt as JSON-serialized, untrusted reference material.
- **Prompt injection prevention:** Walkthrough findings are serialized with `JSON.stringify()` and wrapped in a fenced code block with explicit "untrusted, model-generated" disclaimer. Prevents delimiter attacks from cached model output.
- **URL normalization:** `WalkthroughCache.normalizeKey()` strips query strings, fragments, and extra path segments from GitHub PR URLs so different URL variants map to the same cache key.
- **Bounded memory:** LRU-style eviction (max 20 entries) + per-entry cap (500K chars) prevents unbounded growth. Uses Map insertion order with delete-then-set for ordering.
- **Extracted shared utility:** `toolUtils.ts` consolidates `MAX_TOOL_RESULT_LENGTH` and `truncateToolContent()` — previously duplicated between `walkthroughParticipant.ts` and `aiReviewAction.ts`.
- **Consent ordering:** Worktree preparation happens AFTER user confirms the consent dialog, not before. Avoids expensive clone work if user cancels.
- **toolInvocationToken: undefined:** The standalone review action passes `undefined` for `toolInvocationToken` since it runs outside a chat participant context. This may prompt user consent at runtime.
- **Files changed:** `aiReviewAction.ts` (major rewrite), `extension.ts`, `walkthroughParticipant.ts`, `walkthroughCache.ts` (new), `toolUtils.ts` (new), plus test files.

### 2026-04-18 — Issue #215 (Dynamic Editor Titles)

**PR #313:** Editor panel titles now update dynamically from provider source data.
- **Core pattern:** Added `resolveTitle()` to `WorkItemEditorPanel` — looks up live title from `ProviderRegistry.getDiscoveredItems()`, falling back to the persisted `item.title`. Same approach as tree views' `titleResolver` but directly on the registry since the editor already has access for description/state lookups.
- **Targeted postMessage updates:** On `onDidChangeDiscoveredItems`, `checkTitleUpdate()` pushes just the new title to the webview via `postMessage({ type: 'updateTitle' })` instead of a full HTML re-render. This preserves unsaved notes edits. The webview handler targets `#title-link` child if present (preserving clickable heading links from #281) and only updates the input value when `readOnly`.
- **Managed state tracking:** Copilot review caught that `onDidChangeDiscoveredItems` also fires when providers register/unregister, which changes the managed (readonly) state. Added `lastManagedState` tracking — when it flips, a full `update()` re-render runs instead of a targeted title-only update.
- **`displayTitle` on `EditorHtmlOptions`:** Added optional `displayTitle` property; heading and title input use it (falling back to `item.title`). This is an internal interface, not public API — no breaking change.
- **Files changed:** `packages/core/src/views/editorPanelHtml.ts`, `packages/core/src/views/workItemEditorPanel.ts`, plus test files.

### 2026-04-20 — Issue #266 (Watch CI Pipelines)

**Implementation:** Fire-and-forget pipeline watching for GitHub Actions and Azure DevOps Pipelines.
- **Hybrid architecture:** Core owns `WatcherService` lifecycle (poll, notify), providers supply `DevDocketRunWatcher` interface (canWatch, parseRunUrl, getRunStatus).
- **New API surface:** `DevDocketRunWatcher` in `@devdocket/shared`, `registerRunWatcher()` on `DevDocketApi` (additive, non-breaking). Optional interface mirrors existing provider/action pattern.
- **Persistence:** Watches persisted to `watches.json` via `WatchStore` (write-queue serialization). Restored on activation — dismissed watches excluded. Active watches resume polling automatically.
- **Polling with concurrency guard:** `WatcherService` polls active watches every 60s (configurable, min 15s). Skips tick if previous poll still in-flight. After 3 consecutive failures, sets warning flag and skips that run in subsequent polls.
- **Early failure notifications:** `onDidDetectJobFailure` fires when job completes with `failure` conclusion while overall run is still in progress. Notification shows running job count. Gated by `devdocket.watches.notifyOnJobFailure` (default: true).
- **UI components:** (1) `WatchesTreeProvider` (6th view): run nodes with job children, description shows repo/runId/state. (2) `WatchesStatusBar`: right side, shows counts, click for quick-pick. (3) Notification toasts on completion and job failure.
- **Commands:** `watchRun` (input box with URL validation), `dismissWatch`, `dismissAllCompletedWatches`, `openWatchUrl`. All wired in context menus and view title.
- **GitHub Actions implementation:** `GitHubActionsWatcher` in `packages/github` parses `github.com/.../actions/runs/...` URLs, uses REST API with GitHub auth session. Maps API status/conclusion to shared enums. Registered conditionally if `registerRunWatcher` exists on API (graceful degradation for older core).
- **ADO Pipelines implementation:** `AdoPipelineWatcher` in `packages/ado` parses `dev.azure.com/{org}/{project}/_build/results?buildId=...` URLs. Uses ADO Build + Timeline APIs with silent auth via `getAdoHeaders()`. Filters timeline records by `type === 'Job'` for job-level detail.
- **Configuration:** `devdocket.watches.pollingIntervalSeconds` (default: 60, min: 15), `devdocket.watches.notifyOnJobFailure` (default: true).
- **Files changed:** 
  - `packages/shared/src/runWatcher.ts` (new), `index.ts`
  - `packages/core/src/api/types.ts`, `devDocketApi.ts`, `extension.ts`, `commands/commands.ts`, `package.json`
  - `packages/core/src/services/watcherRegistry.ts` (new), `watcherService.ts` (new)
  - `packages/core/src/views/watchesTreeProvider.ts` (new), `watchesStatusBar.ts` (new)
  - `packages/core/src/test/__mocks__/vscode.ts` (StatusBarAlignment)
  - `packages/github/src/githubActionsWatcher.ts` (new), `extension.ts`
  - `packages/ado/src/adoPipelineWatcher.ts` (new), `extension.ts`

### 2026-04-18 — Issue #319 (Focus View Provider Grouping)

**PR #320:** Focus view now groups items by provider in tree mode, matching Sources view pattern.
- **Removed custom grouping logic:** Focus view had custom `getChildren()` and `getParent()` implementations that grouped by `item.group` (repo name). Removed these overrides to use the base class `WorkItemViewProvider` pattern which groups by provider.
- **WorkItemViewProvider base class:** The base class already implements provider grouping via `getTreeModeChildren()` helper in `viewLayout.ts`. It creates a two-level hierarchy: provider → sub-group (item.group) → items. This is consistent with Queue, History, and Sources views.
- **Tree hierarchy:** In tree mode, items are now grouped: Provider (GitHub, ADO, etc.) → Sub-group (repo name) → Work Items. Manual items appear under "Other" provider group. In flat mode, unchanged.
- **No breaking changes:** The public API surface is unchanged — only internal tree provider implementation.
- **Files changed:** `packages/core/src/views/focusTreeProvider.ts` (removed ~60 lines of custom grouping logic).

### 2026-04-20 — Issue #299 (Double Disposal in Deactivate)

**PR #325:** Fixed double disposal in `extension.ts` deactivate() and cleaned up 4 unused module variables.
- **Bug:** `deactivate()` called `.dispose()` on resources twice due to missing guard. Cleaned up unused variables in extension module.
- **Impact:** Improves shutdown reliability and prevents resource leaks. 1704 tests pass.
- **No API changes.** Isolated to extension lifecycle management.

### 2026-04-20 — Issue #298 (Add Timeouts to Fetch/Git Calls)

**PR #326:** Added timeout configuration to all fetch() and git subprocess calls to prevent hanging on network delays.
- **Scope:** Applied consistently across GitHub, ADO, and generic providers.
- **Pattern:** Timeout handling with graceful error messaging for user feedback.
- **Impact:** Improves reliability on flaky networks. 1898 tests pass.
- **No API surface changes.**

### 2026-04-20 — Issue #300 (Wire CancellationToken to AbortSignal)

**PR #327:** Integrated VS Code CancellationToken with AbortSignal across 7 provider files for consistent cancellation semantics.
- **Pattern:** Providers now receive `vscode.CancellationToken` in constructor. Wired to `AbortSignal` for fetch/git operations.
- **Scope:** GitHub, ADO, and generic provider implementations.
- **Note:** Breaking change — provider constructors require CancellationToken. Migration documented in PR.
- **Impact:** Ensures responsive cancellation on user action and extension shutdown.

### 2026-04-20 — Documentation Refresh

**PR #328:** Rewrote README and created UX guide for configuration details.
- **README changes:** Removed marketplace-specific language, added build-from-source workflow, condensed feature descriptions.
- **New guide:** Dedicated UX guide for configuration and developer setup.
- **Impact:** Improves developer experience for local builds. 5 rounds Copilot review passed.
### 2026-04-20 — Issue #299 (Remove double disposal of resources)

**Bug:** `deactivate()` manually disposed 4 resources (`providerRegistry`, `actionRegistry`, `workGraph`, `stateStore`) that were already registered in `context.subscriptions` for VS Code auto-disposal. This caused every resource to be disposed twice.
- **Fix:** Removed all manual disposal from `deactivate()`, making it a true no-op. Removed the module-level variables and their assignments since they only existed to support the manual disposal.
- **VS Code idiom:** Rely exclusively on `context.subscriptions` for resource lifecycle management. VS Code calls `dispose()` on all subscriptions during deactivation automatically.
- **Files changed:** `packages/core/src/extension.ts` only.

### 2026-04-20 — Security & Concurrency Sprint

**Team outcome:** 5 PRs completed in parallel coordination with Hockney.

- **PR #327 — CancellationToken Race Condition Fix:** Fixed race condition in `combineSignals()` where concurrent updates corrupted state. Resolved all code review feedback in single cycle.
- **PR #328 — README Refresh:** Rewritten documentation with UX guide creation. Mermaid diagram removed. Merge conflicts resolved cleanly.
- **PR #330 — Credential Exposure Security Fix:** Moved git authentication from CLI arguments to `GIT_CONFIG` environment variables. Unified gitExec signature. 7-round review cycle completed.
- **PR #331 — BaseRef Sanitization Hardening:** Replaced weak denylist with strict `isValidRef()` allowlist validation. Only valid git refs accepted. 3-round review cycle completed.

**Hockney's contribution:** 44 new tests across 5 files covering AbortSignal wiring and cancellation paths (PR #329, 1942 tests passing).

**Key patterns emerged:**
- Environment variable patterns for sensitive data (applicable to future credential management).
- Allowlist validation more secure than denylist (applicable to all input validation).
- Concurrent signal handling requires careful synchronization (document in concurrency guidelines).

### 2026-04-20 — Issue #303 (BaseGitHubProvider extends BaseProvider)

**Refactored** BaseGitHubProvider to extend BaseProvider from @devdocket/shared instead of duplicating infrastructure.
- **Removed duplication:** Event emitter lifecycle, refresh timer, concurrency guard, and disposal were all duplicated from BaseProvider. Now inherited.
- **Inherited _disposed guard:** BaseProvider.dispose() sets _disposed = true and checks it in startPeriodicRefresh and 
efreshInBackground. GitHub providers now get this protection automatically.
- **Split refresh paths:** Replaced single doRefresh(isUserTriggered) with separate 
efresh(token?) (user-triggered) and doBackgroundRefresh() (silent auth). Matches ADO provider pattern.
- **Re-exports from shared:** DiscoveredItem, Disposable, Event, ResolvedItem now imported from @devdocket/shared instead of being re-declared locally.
- **No subclass changes needed:** githubProvider.ts, githubPrReviewProvider.ts, and githubMyPrsProvider.ts required zero changes.
- **Files changed:** packages/github/src/baseGithubProvider.ts only (37 insertions, 77 deletions).
