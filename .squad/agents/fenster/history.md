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
#282 (provider state in editor), #281 (clickable title), #275 (History→Queue transitions),#273 (tree counts), #250 (group context), #249 (accept-to-focus, pre-shipped), #243 (version resurfacing), #240 (create from URL), #233 (provider health), #232 (clear history), #231 (sources icons), #230 (layout toggle), #229 (emoji removal), #227 (provider labels), #223 (dead code cleanup), #222 (responsive layout), #221 (contextual heading), #219 (source URL link), #217 (editor metadata), #216 (provider description), #215 (dynamic titles), #189 (dismissed fix), #178 (ADO filtering), #158 (markdown injection), #157 (API trust boundary), #156 (URL sanitization), #155 (URL scheme validation), #154 (crypto.randomUUID), #153 (JSON validation), #152 (path traversal fix), #12 (AI PR actions), bulk rename (WorkCenter→DevDocket)

> Full issue-level learnings archived to `history-archive.md`

## Learnings

### 2026-04-17 Round 2 — Issue #281 (Clickable Title Hyperlink)

**PR #293:** Made the editor panel title a clickable hyperlink instead of a separate "Open in browser" button.
- **Key pattern:** Webview hyperlinks use `<a>` with real `href` + `data-url`, but click handler calls `e.preventDefault()` + `postMessage({ type: 'openUrl' })` for VS Code's `openExternal`. The `href` attribute enables copy-link-address and screen reader access.
- **Security:** Title link rendering is gated by `isSafeUrl()` — unsafe schemes (javascript:, data:) render plain text. This prevents unsafe URLs from appearing in `href` even though the `postMessage` handler also validates.
- **Accessibility:** `<a href="...">` is keyboard-focusable. Added `:focus`/`:focus-visible` CSS styles with `outline` for visible focus indicator. Added `title="Open in browser"` tooltip for discoverability.
- **Files changed:** `packages/core/src/views/editorPanelHtml.ts` (source), `packages/core/src/test/editorPanelHtml.test.ts` (tests). Now imports `isSafeUrl` from `../utils/url`.

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
