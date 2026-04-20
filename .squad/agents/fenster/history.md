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
- **Git operation safety:** Check branch existence, directory existence, rollback on failure. Use `path.join()` for cross-platform paths.
- **Stable external IDs:** `owner/repo#number` format. URL-imported items use `providerId: 'url-import'`.
- **Webview security:** CSP `default-src 'none'`. `escapeHtml()` for text, `escapeAttr()` for attributes. External links via `postMessage` + `isSafeUrl()`.
- **Markdown injection prevention:** `appendText()` for user-controlled strings, not `appendMarkdown()`.
- **Prompt injection prevention:** Sanitize URLs via `new URL(url)` + strip control chars before LLM prompt interpolation.
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
#299 (fix double disposal), #323 (watch CI pipelines), #322 (auto-complete activity log), #320 (focus view grouping), #282 (provider state in editor), #281 (clickable title), #276 (auto-track authored PRs), #275 (History→Queue transitions), #273 (tree counts), #265 (auto-complete on close), #255 (provider metadata docs), #250 (group context), #249 (accept-to-focus, pre-shipped), #243 (version resurfacing), #240 (create from URL), #233 (provider health), #232 (clear history), #231 (sources icons), #230 (layout toggle), #229 (emoji removal), #227 (provider labels), #223 (dead code cleanup), #222 (responsive layout), #221 (contextual heading), #219 (source URL link), #217 (editor metadata), #216 (provider description), #215 (dynamic titles), #189 (dismissed fix), #178 (ADO filtering), #158 (markdown injection), #157 (API trust boundary), #156 (URL sanitization), #155 (URL scheme validation), #154 (crypto.randomUUID), #153 (JSON validation), #152 (path traversal fix), #12 (AI PR actions), bulk rename (WorkCenter→DevDocket)

> Full issue-level learnings archived to `history-archive.md`

## Learnings

### 2026-04-22 — Issue #300 (CancellationToken → AbortSignal wiring)

**Bug fix:** Providers accepted `CancellationToken` in `refresh()` but only checked `isCancellationRequested` at discrete points. In-flight `fetch()` calls ran to completion even after cancellation.
- **Pattern:** Create `AbortController` at refresh entry point, wire `token?.onCancellationRequested?.(() => abortController.abort())` with double optional chaining (test mocks may lack the event method), pass `abortController.signal` to all `fetch()` calls down the chain.
- **AbortError handling:** Catch `AbortError` (check `err.name === 'AbortError'`) at the top-level and log at debug level, not error. Don't fire empty items on abort — preserves previous provider state.
- **Worker pool abort:** Add `if (signal?.aborted) { break; }` at top of worker loops. Add abort check in catch blocks to avoid logging expected errors.
- **Files changed:** `baseGithubProvider.ts` (core wiring), `githubProvider.ts`, `githubPrReviewProvider.ts`, `githubMyPrsProvider.ts`, `adoWorkItemProvider.ts`, `adoPrReviewProvider.ts`, `adoPipelineWatcher.ts` (inter-fetch check).
- **Key lesson:** `?.` on `token?.onCancellationRequested(...)` only guards against `token` being nullish. If `token` exists but lacks `onCancellationRequested` (like test mocks), it throws. Must use `token?.onCancellationRequested?.(...)` with double optional chaining.
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

### 2026-04-17 Round 3 — Issue #265 v1 (Auto-Complete — superseded by redesign above)

**PR #297:** Auto-complete work items when their linked external item disappears from a provider refresh.
- **Disappearance detection approach:** Compare previous vs current discovered items inline in `handleDiscoveredItems`. Items that disappear and had `accepted` inbox state are considered externally closed/merged. No changes to `DiscoveredItem` interface or providers needed.
- **Key design decision:** Detection runs in `handleDiscoveredItems` (not in `refreshWithTimeout`) so it works for ALL refresh paths — both registry-managed and provider-managed periodic background refreshes. Initial approach deferred to `refreshWithTimeout` which missed background refreshes.
- **State machine expansion:** Added `New → Done` and `Paused → Done` transitions to `VALID_TRANSITIONS`. Required for auto-complete of items in Queue (New) and Focus (Paused). Updated state diagram docs in `workItem.ts`.
- **Guards:** (1) Empty-current guard prevents mass false positives from silent provider failures. (2) Truncation guard skips detection when `MAX_ITEMS_PER_PROVIDER` was exceeded. (3) First-refresh no-op (previous items empty).
- **Event-driven separation:** `ProviderRegistry.onDidDetectCompletedItems` handles detection; `extension.ts` handles transition + notification. Clean separation.
- **Setting:** `devdocket.autoCompleteOnClose` (default: true) in `packages/core/package.json`.
- **Known tradeoff:** Partial provider failures (e.g. one repo fails) can cause false positives. Acceptable for v1 — items can be moved back from History to Queue.
- **Files changed:** `providerRegistry.ts`, `extension.ts`, `workGraph.ts`, `workItem.ts`, `package.json`, `workGraph.test.ts`

### 2026-04-17 Round 2 — Issue #261 (Walkthrough Large PR Fix)

**PR #294:** Fixed AI Walkthrough failing on large external PRs due to context overflow.
- **Root cause:** `getDiffTool` returned raw `git diff` output with no size limit. For large PRs (hundreds of files), multi-MB diffs overflowed the model's context window. The model provider truncated earlier messages, removing the assistant message with `tool_use` blocks while keeping `tool_result` messages — API error: "unexpected tool_use_id found in tool_result blocks".
- **Two-layer fix:** (1) `getDiffTool.ts` truncates at 75K chars with `--stat` summary + footer guiding model to use `getFileDiff`. (2) `walkthroughParticipant.ts` truncates any tool result text part exceeding 80K chars as defense-in-depth.
- **Budget arithmetic:** MAX_DIFF_LENGTH (75K) must be below MAX_TOOL_RESULT_LENGTH (80K) so the tool's own truncation output (stat + footer) survives the participant's safety net. Stat summaries are themselves truncated if too large, never dropped.
- **Files changed:** `packages/ai-reviewer/src/tools/getDiffTool.ts`, `packages/ai-reviewer/src/walkthroughParticipant.ts`
- **Key exports:** `MAX_DIFF_LENGTH`, `MAX_TOOL_RESULT_LENGTH`, `truncateToolContent` — all exported for testability.

### 2026-04-17 Round 2 — Issue #281 (Clickable Title Hyperlink)

**PR #293:** Made the editor panel title a clickable hyperlink instead of a separate "Open in browser" button.
- **Key pattern:** Webview hyperlinks use `<a>` with real `href` + `data-url`, but click handler calls `e.preventDefault()` + `postMessage({ type: 'openUrl' })` for VS Code's `openExternal`. The `href` attribute enables copy-link-address and screen reader access.
- **Security:** Title link rendering is gated by `isSafeUrl()` — unsafe schemes (javascript:, data:) render plain text. This prevents unsafe URLs from appearing in `href` even though the `postMessage` handler also validates.
- **Accessibility:** `<a href="...">` is keyboard-focusable. Added `:focus`/`:focus-visible` CSS styles with `outline` for visible focus indicator. Added `title="Open in browser"` tooltip for discoverability.
- **Files changed:** `packages/core/src/views/editorPanelHtml.ts` (source), `packages/core/src/test/editorPanelHtml.test.ts` (tests). Now imports `isSafeUrl` from `../utils/url`.

### 2026-04-17 Round 3 — Issue #280 (Auto-Reveal Items)

**PR #296:** Auto-reveal items in destination tree view when moved between views.
- **Key pattern:** `ViewRevealer` service wraps `TreeView.reveal()` for Queue, Focus, and History views. State-to-view mapping: New→Queue, InProgress/Paused→Focus, Done/Archived→History. All reveals are best-effort (try-catch, debug-level logging).
- **`getParent()` required for reveal:** VS Code's `TreeView.reveal()` needs `getParent()` to walk up the tree hierarchy. Added to `WorkItemViewProvider` base (ProviderGroup→SubGroup→WorkItem) and overridden in `FocusTreeProvider` (SubGroup→WorkItem, no ProviderGroup).
- **HistoryTreeProvider bug fix:** Was missing `treeItem.id = item.id` — needed for `reveal()` to match elements. Queue and Focus already set this.
- **Error path fix:** Added `return` after `handleCommandError` in accept functions — without it, execution fell through to the reveal call after a failed operation.
- **Batch operations skip reveal:** Multi-select transitions don't reveal since there's no single target item. Single-item ops reveal in the destination view.
- **Files:** `packages/core/src/services/viewRevealer.ts` (new), `packages/core/src/views/viewLayout.ts`, `packages/core/src/views/focusTreeProvider.ts`, `packages/core/src/views/historyTreeProvider.ts`, `packages/core/src/commands/commands.ts`, `packages/core/src/extension.ts`.

### 2026-04-17 Round 3 — Issue #282 (Provider State in Editor)

**PR #295:** Added upstream provider state display to the item editor panel metadata section.
- **Pattern:** Added optional `state?: string` to `DiscoveredItem` (non-breaking API change). Each provider populates it from their API response — GitHub issues use `issue.state`, ADO work items use `System.State`, ADO PRs use `pr.status`.
- **Conditional inclusion:** Use spread `...(value ? { state: value } : {})` or conditional assignment `if (value) { item.state = value; }` to avoid emitting `state: undefined` on discovered items. This prevents `toEqual` test mismatches and keeps the data clean.
- **Guard pattern:** Provider State row in the editor metadata is gated on both `providerState` and `item.providerId` for defensive consistency with the Provider row guard.
- **Merged-state detection:** Initially added `pull_request.merged_at` check for GitHub PRs but removed it — the Search API only returns `state:open` PRs so `merged_at` would never fire. Use `pr.state` directly.
- **Files changed:** `packages/shared/src/baseProvider.ts`, `packages/github/src/baseGithubProvider.ts`, all 4 provider files, `packages/core/src/views/editorPanelHtml.ts`, `packages/core/src/views/workItemEditorPanel.ts`.

### 2026-04-17 Round 1 — Parallel Multi-Issue Sprint

**Issues #275 & #273 completed in tandem** with test coverage from Hockney:
- **Issue #275 (History→Queue):** State transitions Done→New and Archived→New. Fixed sortOrder race condition with temporary state mutation pattern. All 1071 tests pass.
- **Issue #273 (Tree node counts):** Child count badges on all tree view parent nodes. Applied existing Inbox pattern to Queue, Focus, History, Sources.
- **Code review fix:** Preserved write-after-persist pattern by computing sortOrder with temporary state mutation, then restoring original state before store.save().

### 2026-04-18 — Issue #260 (Item Activity Log)

**PR #312:** Added append-only activity log to work items for audit trail.
- **Model design:** New `ActivityLogEntry` type with `timestamp`, `type` (discriminated union), and optional `detail`. Stored as `activityLog?: ActivityLogEntry[]` on `WorkItem` — non-breaking optional field.
- **Automatic logging:** `WorkGraph.createItem()` logs `created`, `transitionState()` logs `state-changed` with `"OldState → NewState"` detail, `updateItem()` logs `updated` with changed field names — but only when fields actually changed (no-op autosaves are silent).
- **Public API:** Optional `addActivity?()` on `DevDocketApi` for satellite extensions. `DevDocketApiImpl` now takes `WorkGraph` in constructor (wiring change in `extension.ts`).
- **Timestamp consistency pattern:** All mutation methods capture `const now = Date.now()` once, reusing it for both the activity entry timestamp and `updatedAt`. Review caught the double-`Date.now()` anti-pattern in `updateItem`, `transitionState`, and `addActivity`.
- **Deep store validation:** `jsonTaskStore` validates each activity log entry (timestamp: finite number, type: non-empty string, detail: string if present). Not just array-ness.
- **Log trimming:** Capped at `MAX_ACTIVITY_LOG_ENTRIES` (100), oldest entries trimmed via `slice()`. Static `appendLogEntry` helper keeps logic pure and testable.
- **Editor panel rendering:** Activity timeline in reverse-chronological order below metadata. Uses `escapeHtml()` for all dynamic content. Conditionally hidden when log is empty/undefined.
- **Merge conflict:** `editorPanelHtml.ts` conflicted with #281 (title hyperlink) — needed both `isSafeUrl` import and `ActivityLogEntry` import, plus both CSS blocks (title-link focus styles and activity log styles).
- **Files changed:** `activityLog.ts` (new), `workItem.ts`, `workGraph.ts`, `jsonTaskStore.ts`, `types.ts`, `devDocketApi.ts`, `extension.ts`, `editorPanelHtml.ts`, plus 4 test files.
### 2026-04-18 — Issue #254 (AI Walkthrough Model Selection)

**PR #310:** Added AI model selection prompt to both AI Walkthrough and AI Code Review actions.
- **Shared utility pattern:** Extracted `selectModel()` in `packages/ai-reviewer/src/selectModel.ts`. Auto-selects when one model available, shows QuickPick for multiple. Reused by both actions.
- **Model placement UX:** Model selection happens BEFORE `withProgress` in both actions. Placing it inside `withProgress` causes QuickPick to appear behind the progress notification — a real UX bug caught in code review.
- **Preferred model propagation:** `AiWalkthroughAction` passes selected model to `WalkthroughParticipant` via `onModelSelected` callback wired in `extension.ts`. Participant uses it when `request.model` is undefined (priority: request.model > preferredModel > fallback selectChatModels).
- **URL validation guards:** Copilot review flagged that `run()` should validate PR URLs before prompting for model selection. Added `!this.isPrUrl()` and `parsePrUrl()` guards in both actions.
- **Breaking change from gpt-4o preference:** Old `BasePrAction.analyzeWithAi()` preferred `gpt-4o` family, now `selectModel()` shows all models. Intentional — lets users choose freely. `WalkthroughParticipant` fallback still uses `gpt-4o` filter.
- **Files changed:** `selectModel.ts` (new), `basePrAction.ts`, `aiWalkthroughAction.ts`, `walkthroughParticipant.ts`, `extension.ts`, plus test files.

### 2026-04-18 — Issue #226 (Keyboard Shortcuts) — Already Done

**No PR needed.** Issue #226 was already fully addressed by PR #259 (commit `8d0df52`), which added all requested keybindings with a `Ctrl+Alt+D` chord prefix. The issue remained open because GitHub doesn't auto-close issues when PRs merge to non-default branches (`dev` instead of `main`). Closed the issue manually with a comment referencing the existing PR.

### 2026-04-18 — Issue #215 (Dynamic Provider Titles — Reworked)

**PR #313:** Provider-backed work item titles now sync at the store level during provider refresh.
- **Store-level sync vs view-level resolution:** Initial approach resolved live titles at display time in the editor panel. Matt's feedback: update the persisted `WorkItem.title` in the store instead, so all views (tree, editor, tooltips) update naturally via the existing `onDidChange` event system. Covers imported/linked items too — any item with matching `providerId + externalId`.
- **`titleSync.ts` service:** `syncProviderTitles()` iterates `providerRegistry.getAllDiscoveredItems()`, uses `workGraph.findItemByProvenance()` (O(1) via provenanceIndex) for each, and calls `workGraph.updateItem()` when titles differ. Per-item try/catch for resilience. Guards against empty/whitespace-only provider titles via `discovered.title?.trim()`.
- **Editor panel event subscriptions:** Three subscriptions: `workGraph.onDidChange` (title changes), `providerRegistry.onDidRegisterProvider` (managed state on register), `providerRegistry.onDidChangeDiscoveredItems` (managed state on deregister). Title-only changes use `postMessage` (preserves unsaved notes); managed-state changes trigger full re-render.
- **`updateTitle` webview handler:** Targets `#title-link` child if present (preserving clickable heading from #281), only updates readonly input (prevents overwriting user edits in non-managed items).
- **Key Copilot review fixes:** (1) Whitespace-only title guard. (2) Subscribe to `onDidChangeDiscoveredItems` for deregistration detection. (3) Remove redundant `panel.title` set in `saveData()` — let `checkForUpdates()` handle it consistently.
- **Files changed:** `packages/core/src/services/titleSync.ts` (new), `packages/core/src/extension.ts`, `packages/core/src/views/workItemEditorPanel.ts`, `packages/core/src/views/editorPanelHtml.ts`, plus test files.

### 2026-04-18 — Issue #253 (Share Cloned Repo Between AI Actions)

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

### 2026-04-20 — Issue #299 (Remove double disposal of resources)

**Bug:** `deactivate()` manually disposed 4 resources (`providerRegistry`, `actionRegistry`, `workGraph`, `stateStore`) that were already registered in `context.subscriptions` for VS Code auto-disposal. This caused every resource to be disposed twice.
- **Fix:** Removed all manual disposal from `deactivate()`, making it a true no-op. Removed the module-level variables and their assignments since they only existed to support the manual disposal.
- **VS Code idiom:** Rely exclusively on `context.subscriptions` for resource lifecycle management. VS Code calls `dispose()` on all subscriptions during deactivation automatically.
- **Files changed:** `packages/core/src/extension.ts` only.
