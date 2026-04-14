# Fenster — Extension Dev — History

## Core Context

WorkCenter is a VS Code extension for managing work items. Phase 1 is complete:
- Queue view (new items) and Focus view (in-progress items) as tree data providers
- Manual work item creation via input box, editing via webview panel with auto-save
- 6-state WorkItem model (New, InProgress, Blocked, WaitingOn, Done, Archived)
- WorkGraph service: in-memory Map, event-driven, ITaskStore abstraction
- JsonTaskStore: all items persisted in a single `workitems.json` file in globalStorageUri
- 6-state WorkItem model (New, Triaged, InProgress, Paused, Done, Archived)
- WorkGraph service: in-memory Map, event-driven, ITaskStore abstraction
- JsonTaskStore: single `workitems.json` file in `globalStorageUri` containing an array of items
- 19 passing vitest tests
- esbuild bundler, TypeScript strict mode

Key files:
- `src/models/workItem.ts` — model + state enum
- `src/services/workGraph.ts` — core service
- `src/storage/jsonTaskStore.ts` — persistence (implements ITaskStore from `src/storage/taskStore.ts`)
- `src/views/` — inboxTreeProvider, focusTreeProvider, workItemEditorPanel
- `src/commands/commands.ts` — all command registrations
- `src/extension.ts` — activation entry point
- `vitest.config.ts` — test config
- `package.json` — contributes views, commands, menus

## Learnings

- GitHub package (`packages/github/`) vscode mock lives at `packages/github/src/test/__mocks__/vscode.ts`, aliased in `vitest.config.ts` — mirrors core mock pattern but adds `authentication`, `workspace`, `extensions` mocks.
- Mock includes: `authentication.getSession` (resolves with `{ accessToken: 'mock-token' }`), `workspace.getConfiguration` (returns `.get(key, default)` stub), `workspace.workspaceFolders`, `extensions.getExtension`, `commands.executeCommand`, `Uri.file`, `window.showErrorMessage`.
- Root `npm install` handles all workspace deps via npm workspaces. Root `npm run build` runs esbuild in both packages.
- Both packages use esbuild with `--external:vscode --format=cjs --platform=node`.
- Core has 38 tests (4 test files). GitHub package has test infra ready but no test files yet.
- Key github source files: `githubProvider.ts` (fetches GitHub issues via REST API), `startWorkAction.ts` (creates git branch + worktree), `extension.ts` (acquires core API, registers provider + action).

## Phase 2 Completion (2026-03-24)

**Status:** COMPLETE — Infrastructure and builds verified.
- Created GitHub vscode mock with authentication, workspace, extensions mocks
- Ran npm install and npm run build — all workspace deps resolved, both packages built successfully
- Verified esbuild output for core and github packages
- Ready for Phase 3 planning

## Phase 3: Inbox/Sources Discovery System

**Status:** COMPLETE — All 10 implementation steps done, build passes, 64/64 tests pass.

### Learnings

- **InboxState enum** (`unseen | accepted | dismissed`) persisted as `discovered-state.json` alongside `workitems.json`. DiscoveredStateStore uses same ENOENT/mkdir pattern as JsonTaskStore but adds a vscode.EventEmitter for change notifications.
- **ProviderRegistry no longer creates WorkItems.** Providers store discovered items in an in-memory Map; WorkItem creation only happens through explicit user actions (accept commands). Constructor now takes `(workGraph, stateStore)`.
- **Tree element types differ per view:** Inbox uses `InboxItem` (flat DiscoveredItem + providerId), Sources uses a discriminated union (`SourceProviderNode | SourceGroupNode | SourceItemNode`), Queue/Focus still use `WorkItem`. Command handlers receive these element types directly from VS Code tree clicks.
- **Migration pattern:** On activation, scan existing WorkItems with providerId+externalId and write `accepted` entries to stateStore before registering tree providers. This prevents re-surfacing already-accepted items.
- **Dismissed items are sticky** — the stateStore check in `handleDiscoveredItems` only writes `unseen` for items with no existing state, preserving `dismissed` and `accepted`.
- **`openInBrowser` command** updated to handle both WorkItem (via `item.id` lookup) and discovered items (direct `item.url` fallback).
- **GitHub provider** now sets `group: owner/repo` parsed from `html_url` via regex, enabling Sources tree grouping by repository.

### Key New Files
- `src/storage/discoveredStateStore.ts` — InboxState persistence + change events
- `src/views/queueTreeProvider.ts` — renamed from old InboxTreeProvider (shows WorkItems in New state)
- `src/views/inboxTreeProvider.ts` — NEW, shows unseen DiscoveredItems from all providers
- `src/views/sourcesTreeProvider.ts` — hierarchical Provider → Group → Item tree

## Learnings (Updated 2026-03-24)

### File Structure and Conventions
- DiscoveredStateStore follows same ENOENT/mkdir pattern as JsonTaskStore for consistent file handling
- Tree provider element types vary per view: flat InboxItem (inbox), union discriminated types (sources), WorkItem (queue/focus)
- Command handlers receive element types directly from VS Code tree clicks — no need to re-fetch from store

### Event-Driven Architecture
- DiscoveredStateStore and ProviderRegistry both fire change events — views subscribe to both for immediate UI updates
- Provider refresh and user actions (accept/dismiss) both trigger onDidChange events for reliable view synchronization

### Sticky State Semantics
- Dismissed items marked in state store are never cleared by provider refresh — dismissal is a permanent user preference
- Migration logic runs on activation before tree registration to seed existing WorkItems as 'accepted'
- Items with no persisted state default to 'unseen' — allows new providers to introduce items without re-surfacing old ones

### Editor Panel HTML
- The editor heading (`<h2 id="editor-heading">`) uses `escapeHtml(item.title)` instead of a generic "Edit Work Item" string — keeps it contextual while preserving `aria-labelledby` accessibility (Issue #221)
- `escapeHtml` and `escapeAttr` are local helpers in `editorPanelHtml.ts` — use `escapeHtml` for text content, `escapeAttr` for attribute values
### Emoji Removal in Tree Descriptions (Issue #229)
- Tree item descriptions should use plain text labels, not Unicode emoji — emoji render inconsistently across platforms, fonts, and themes
- Fixed in `packages/core/src/views/focusTreeProvider.ts` (`getStateLabel`) and `packages/core/src/views/historyTreeProvider.ts` (`getStateLabel`)
- State is already conveyed by ThemeIcon (`debug-pause`, `check`, `archive`), so descriptions only need plain text: `"paused"`, `"done"`, `"archived"`

## Code Review Fixes (2026-03-24)

Fixed all Critical (C1-C7) and Important (I1-I8) issues from Keaton's review for PR #1:

### Critical Patterns
- **Loading flag management**: Must clear on both success and error paths. The `handleDiscoveredItems` method now clears loading flag after firing discovery event.
- **Async state writes**: Always `await` state store writes in loops to prevent silent failures.
- **Migration error handling**: Wrap each iteration in try-catch to continue even if individual setState fails.
- **API type safety**: Use `typeof api.method !== 'function'` instead of truthiness checks to validate extension APIs.
- **In-memory cache for storage**: Maintain cache as source of truth to avoid read-modify-write races. `JsonTaskStore` now uses `Map<string, WorkItem>` cache.
- **Git branch safety**: Check if branch exists before creation (`git branch --list <name>`). Delete branch on worktree failure for rollback.
- **Path construction**: Use `path.join()` for cross-platform paths, never string concatenation.

### Important Patterns
- **Auth cancellation**: GitHub auth can be cancelled by user. Catch rejection with `.catch(() => null)` and guard against null session.
- **User-facing errors**: Accumulate fetch failures and show a single notification instead of just console logging.
- **View message timing**: Check `getAllDiscoveredItems().size > 0` instead of `hasProviders` to avoid race where providers register before items load.
- **Immutable updates**: Clone before mutating (`{ ...item, ...patch }`) to prevent inconsistent state if save fails.
- **Rollback patterns**: If multi-step operation fails partway (branch created but worktree fails), clean up partial state.
- **Defensive checks**: Check `fs.existsSync()` for worktree directory before attempting creation to give better error messages.
- **Stable external IDs**: Use format like `owner/repo#123` that survives issue transfers, not `html_url` which can change.

## Code Review Fixes (2026-03-24)

Fixed all Critical (C1-C7) and Important (I1-I8) issues from Keaton's review for PR #1:

### Critical Patterns
- **Loading flag management**: Must clear on both success and error paths. The `handleDiscoveredItems` method now clears loading flag after firing discovery event.
- **Async state writes**: Always `await` state store writes in loops to prevent silent failures.
- **Migration error handling**: Wrap each iteration in try-catch to continue even if individual setState fails.
- **API type safety**: Use `typeof api.method !== 'function'` instead of truthiness checks to validate extension APIs.
- **In-memory cache for storage**: Maintain cache as source of truth to avoid read-modify-write races. `JsonTaskStore` now uses `Map<string, WorkItem>` cache.
- **Git branch safety**: Check if branch exists before creation (`git branch --list <name>`). Delete branch on worktree failure for rollback.
- **Path construction**: Use `path.join()` for cross-platform paths, never string concatenation.

### Important Patterns
- **Auth cancellation**: GitHub auth can be cancelled by user. Catch rejection with `.catch(() => null)` and guard against null session.
- **User-facing errors**: Accumulate fetch failures and show a single notification instead of just console logging.
- **View message timing**: Check `getAllDiscoveredItems().size > 0` instead of `hasProviders` to avoid race where providers register before items load.
- **Immutable updates**: Clone before mutating (`{ ...item, ...patch }`) to prevent inconsistent state if save fails.
- **Rollback patterns**: If multi-step operation fails partway (branch created but worktree fails), clean up partial state.
- **Defensive checks**: Check `fs.existsSync()` for worktree directory before attempting creation to give better error messages.
- **Stable external IDs**: Use format like `owner/repo#123` that survives issue transfers, not `html_url` which can change.

### Skipped Issues
- **I3 (contextValue naming)**: Pattern `item.url ? 'inboxItem.hasUrl' : 'inboxItem'` was already consistent across views. No change needed.

### Copilot Review Rounds
Fixed 4 rounds of Copilot PR review feedback:
- Round 1: 17 comments
- Round 2: 4 comments
- Round 3: 4 comments
- Round 4: 7 comments
- **Total: 32 additional fixes beyond review issues**

### Cross-Team Outcomes
- **Keaton**: Re-reviewed all fixes, approved for merge
- **Hockney**: Updated 7 tests + added 3 new test cases to match production changes
- **Squad**: All 124 tests passing (98 core + 26 GitHub)

### Decision Record
Patterns documented in `.squad/decisions.md` under "Code Review Fix Patterns" (2026-03-24).

## Issue #154: crypto.randomUUID() for work item IDs (2026-07-14)

### Learnings
- `crypto.randomUUID()` is available as a Node.js built-in — no additional dependencies needed. Since `crypto` is a native module, it doesn't require a vitest mock (unlike `vscode`).
- The old `generateId()` used `Date.now()` + `Math.random()`, which is predictable. The new format `wc-<uuid>` is simpler and cryptographically secure.
- The codebase already used `crypto.randomBytes()` in `editorPanelHtml.ts` for CSP nonces, so this aligns with existing practice.

## Issue #156: Sanitize PR URL before LLM prompt interpolation (2026-07-14)

### Learnings
- External data interpolated into LLM prompts is a prompt injection vector. Always sanitize before embedding in prompt strings.
- `new URL(url)` is the standard way to validate URL format in Node.js — it throws on malformed input, making try/catch a clean validation pattern.
- `URL.href` returns the canonical, re-serialized URL which normalizes encoding — safer than using the raw input string.
- Stripping `\r`, `\n`, and backticks prevents an attacker from breaking out of the markdown structure in the prompt template.

## Issue #155: URL scheme validation before openExternal (2026-07-14)

### Learnings
- The codebase already had inline URL scheme validation using `vscode.Uri.parse().scheme`, but extracting a dedicated `isSafeUrl()` helper using the standard `URL` constructor is more robust — it catches malformed URLs via try/catch rather than letting `vscode.Uri.parse` silently accept them.
- `URL.protocol` includes the trailing colon (e.g., `'https:'`), while `vscode.Uri.scheme` does not (e.g., `'https'`). Always check which API you're using to avoid subtle mismatches.
- Using the native `URL` constructor for validation means the helper works in both VS Code runtime and Node.js tests without needing vscode mocks.

## Issue #158: Markdown injection in tooltip rendering (2026-07-14)

### Learnings
- `MarkdownString.appendMarkdown()` renders raw markdown — interpolating user-controlled strings (like issue titles) enables markdown injection. Always use `appendText()` for user content, which escapes markdown metacharacters.
- The secure pattern is: `md.appendMarkdown('**Title:** ')` then `md.appendText(item.title)` then `md.appendMarkdown('\n\n')` — label in markdown, value in plain text.
- `queueTreeProvider.ts` and `inboxTreeProvider.ts` were the only two views missing this pattern; `focusTreeProvider.ts`, `sourcesTreeProvider.ts`, and `historyTreeProvider.ts` already used it correctly.

## Issue #157: Plugin API trust boundary validation (2026-04-09)

### Learnings
- VS Code's extension API provides no caller identity context — there is no way to verify which extension is registering a provider or action. The only practical mitigation is logging registrations at warn level for auditability and rejecting duplicate IDs.
- `Readonly<WorkItem>` in TypeScript is a shallow read-only wrapper. It prevents direct property mutation at the type level but doesn't create a runtime-frozen object. For the plugin API surface this is sufficient since it catches accidental mutations at compile time.
- Provider data size limits should be enforced at the ingestion boundary (`handleDiscoveredItems`) rather than at the storage layer, to prevent large arrays from propagating through the event pipeline before being caught.
- The `MAX_ITEMS_PER_PROVIDER` constant is on the class (`static readonly`) rather than module-level, keeping it discoverable alongside the registry and testable via `ProviderRegistry.MAX_ITEMS_PER_PROVIDER`.

## Issue #152: Custom prompt path allows arbitrary file read (2026-07-14)

### Learnings
- `resolvePromptUri` now validates ALL resolved paths (both absolute and relative) are contained within a workspace folder using `path.normalize()` + prefix comparison. Absolute paths are no longer blindly accepted.
- On Windows, path comparison must be case-insensitive (`toLowerCase()` both sides) since `C:\Users` and `c:\users` are the same. `process.platform === 'win32'` is the standard detection.
- `path.normalize()` resolves `..` traversal segments, so `workspace/../../etc/passwd` becomes `etc/passwd` at the filesystem level — the containment check catches this by comparing the normalized result against the normalized workspace root.
- The `getReviewPrompt` catch block now surfaces the actual `Error.message` from validation failures instead of a generic string, so users see exactly why their custom prompt path was rejected.
- 6 existing tests fail because they test the old insecure behavior (absolute paths outside workspace). Hockney needs to update them to use paths within the mock workspace folder (`/mock/workspace/...`).

## Issue #153: JSON deserialization validation and file size limits (2026-07-14)

### Learnings
- ReadStateStore was the only store using an unchecked `JSON.parse(data) as string[]` type assertion. The other two stores (jsonTaskStore, discoveredStateStore) already had full validation + backup-on-corruption patterns. Always validate parsed JSON at runtime, even for simple types like `string[]`.
- A shared `MAX_STORE_FILE_SIZE` constant in `limits.ts` keeps the size guard consistent across all stores and avoids magic numbers scattered across files.
- Changing ReadStateStore from "throw on corruption" to "backup and reset" is a deliberate behavioral change that aligns with the other stores. This breaks the existing test `should handle corrupted JSON by throwing` — flagged for Hockney to update.

## Issue #178: ADO provider state filter (2025-01-22)

### Learnings
- Updated `AdoWorkItemProvider` WIQL query to exclude all non-active work item states: `Closed`, `Removed`, `Resolved`, and `Done`. Previously only excluded `Closed` and `Removed`.
- Updated the class JSDoc comment to document all four excluded states for clarity.
- This prevents resolved/completed work items from appearing in Inbox and Sources views, keeping the UI focused on actionable items.

## Issue #178: State-category-based filtering (2025-01-22)

### Learnings
- Reverted WIQL hardcoded state exclusions from 4 states (`Closed`, `Removed`, `Resolved`, `Done`) back to 2 (`Closed`, `Removed`) as a performance optimization. The other states are not universal across ADO process templates.
- Added two-layer filtering approach: WIQL excludes common terminal states for performance, then state category API filters remaining non-active items for correctness.
- The ADO Work Item Type States API (`/workitemtypes/{type}/states`) returns state definitions with a `category` field. States with categories `Completed`, `Removed`, or `Resolved` are non-active and should be excluded.
- Caching terminal states per `project/workItemType` pair prevents redundant API calls during the same refresh cycle. Cache is instance-level and survives multiple refresh operations.
- **Fail open pattern**: If the states API call fails (network error, parse error, non-ok response), return an empty set of terminal states to avoid filtering out all items. Users see potentially completed items rather than missing active items.
- URL-encoding is required for org, project, and workItemType in all API URLs using `encodeURIComponent()` to handle special characters and spaces.
- Grouping work items by `(project, workItemType)` before fetching states minimizes API calls when multiple items share the same type.

## Issue #12: AI-powered PR actions (2025-07-22)

### Learnings
- **BasePrAction extraction pattern**: Shared PR action logic (diff fetching, LLM interaction, prompt loading, workspace validation) lives in `basePrAction.ts`. Subclasses only provide: `id`, `label`, `configSection`, `defaultPromptContent`, `progressTitle`, `outputHeader`, `confirmationMessage`, and `getRuntimeInstructions()`.
- **Re-export for backward compatibility**: When extracting a function to a base module, re-export it from the original module (`export { sanitizePrUrl }` in `aiReviewAction.ts`) so existing test imports don't break.
- **Enhanced default prompt**: `defaultPrompt.ts` now includes all 10 items from superpowers Step 3 (including "Don't flag what CI catches", enhanced false-positive guidance with "Never assert...deprecated", and "Context-shift analysis"). Also adds Holistic Assessment subsection, Codebase Consistency section, and "Using ✅ Verified" paragraph to Severity Classification.
- **Extension registration**: `extension.ts` creates and registers both `AiReviewAction` and `AiWalkthroughAction` — each gets its own `api.registerAction()` call pushed to `context.subscriptions`.
- **Configuration and prompt sourcing**: `AiReviewAction` uses the `workcenterAiReview` config section with `customPromptPath` in `package.json`. The walkthrough uses the `@walkthrough` chat participant with a built-in prompt — no separate config entry.
## Issue #189: Dismissed items reappearing in inbox (2025-01-24)

### Root Cause
- `DiscoveredStateStore.getState()` is synchronous and reads from an in-memory cache. If called before `await load()` completes, it returns `undefined` for dismissed items that exist in the JSON file but haven't been loaded into the cache yet.
- `ProviderRegistry.handleDiscoveredItems()` calls `getState()` to check if items are dismissed. If it returns `undefined`, the item is treated as new and added to inbox with state `'unseen'`, overwriting the persisted dismissed state.

### Fix
- Added defensive `await this.stateStore.load()` at the start of `handleDiscoveredItems()` before checking item states.
- The load() method is idempotent (returns immediately if already loaded), so this adds negligible overhead in normal operation.
- This guards against edge cases where provider refresh might fire before the initial store load completes during extension activation, or any other timing race conditions.

### Test Updates
- Updated 14 tests that synchronously called `provider.fireItems()` and immediately asserted on state.
- These tests now use `async/await` with `vi.waitFor()` to wait for the async `handleDiscoveredItems` handler to complete before asserting.
- Pattern: `await vi.waitFor(() => { expect(registry.getDiscoveredItems('gh')).toHaveLength(N); });`

### Key Learning
- **Defensive async loading**: When a synchronous getter reads from an async-loaded cache, ensure the cache is loaded at every call site. Don't rely solely on initialization order guarantees.
- **Test timing**: When production code adds an async operation to a previously-synchronous code path, tests that fire-and-forget events need to wait for async handlers to complete before asserting on side effects.

## Issue #227: Queue View Provider Labels (2026-04-13)

**Status:** COMPLETE — Provider labels now display in queue view instead of raw IDs

### Summary
The queue view was displaying raw provider IDs (e.g., `github`, `ado`) in tree items. Extracted `getProviderLabel()` method from `WorkItemViewProvider` base class and applied it in `QueueTreeProvider` to show human-readable labels (e.g., "GitHub Issues").

### Files Modified
- `packages/core/src/views/queueTreeProvider.ts` — Updated tree item label rendering
- `packages/core/src/views/viewLayout.ts` — Extracted `getProviderLabel()` method for reuse across all views

### Key Learnings
- **Label centralization**: Extracting label lookup into the base class prevents duplication and ensures consistency. Any future view that needs provider labels automatically gets the same logic.
- **Provider registry lookup**: The `getProviderLabel()` method uses the `ProviderRegistry` to look up the display name. Falls back gracefully if provider not found.

### Result
- Build: ✅ Passes
- Tests: 870 total (864 existing + 6 new from Hockney)
- Commit: `f667e7d` — "Fix queue view to show provider label instead of raw ID (#227)"

## Issue #189: resurfaceDismissed removal (2025-01-24)

### Root Cause (Corrected)
- The ACTUAL root cause was `resurfaceDismissed = true` on PR review providers. This flag explicitly overwrote dismissed items back to `unseen` on every provider refresh in `handleDiscoveredItems()`. The previous fix (defensive `load()` call) addressed a non-existent race condition.

### Fix
- Removed `resurfaceDismissed` property from: `WorkCenterProvider` interface (core, github, ai-reviewer), `BaseGitHubProvider` class, `GitHubPrReviewProvider`, `AdoPrReviewProvider`.
- Removed the `resurface` variable and `else if (resurface && existing === 'dismissed')` branch from `handleDiscoveredItems()`.
- Reverted the unnecessary `await this.stateStore.load()` and associated test changes from commit 15e237f.
- Removed tests for resurfaceDismissed behavior across all packages.
- Updated extension-api.md and provider-api.md to remove all resurfaceDismissed documentation.

### Key Learnings
- **Dismissed means dismissed**: The original four-view design established that dismissed items are sticky. The `resurfaceDismissed` feature contradicted this core design principle.
- **Root cause matters**: The first fix (defensive load) was plausible but wrong. The symptom (dismissed items reappearing) had a simpler explanation: code explicitly designed to resurface them.
- **Reverting cleanly**: When reverting test changes, `git checkout <commit> -- <files>` is the safest approach to restore files to a known-good state before applying new targeted edits.

## Issue #231: Sources view dismissed icon (2025-07-23)

### Learnings
- **Icon mapping in Sources view**: `packages/core/src/views/sourcesTreeProvider.ts` maps `InboxState` to `ThemeIcon` names via `switch (state)` in `getTreeItem()`: `accepted` → `check`, `dismissed` → `circle-slash`, `unseen` → `circle-outline`. Previously simpler branching lumped dismissed and unseen together.
- **Key file**: `packages/core/src/views/sourcesTreeProvider.ts` — the `getTreeItem()` method for `item` kind elements assigns icons based on `stateStore.getState()` result.
