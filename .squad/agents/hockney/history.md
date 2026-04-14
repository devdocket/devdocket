# Hockney — Tester — History

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

Test infrastructure:
- vitest with `vitest.config.ts`
- VS Code module mocked in `src/test/__mocks__/`
- Test files: `src/test/workGraph.test.ts`, `src/test/jsonTaskStore.test.ts`
- Run: `npm test` (vitest run), `npm run test:watch` (vitest watch)

Key files:
- `src/models/workItem.ts` — model + state enum (6 states: New, InProgress, Blocked, WaitingOn, Done, Archived)
- `src/services/workGraph.ts` — core service with createItem, updateItem, transitionState, deleteItem
- `src/storage/jsonTaskStore.ts` — all items persisted in a single `workitems.json` file in globalStorageUri
- `src/models/workItem.ts` — model + state enum (6 states: New, Triaged, InProgress, Paused, Done, Archived)
- `src/services/workGraph.ts` — core service with createItem, updateItem, transitionState, deleteItem
- `src/storage/jsonTaskStore.ts` — single-file persistence (all items in `workitems.json`)

## Learnings

### Phase 2 Test Writing (2026-03-24)

**Tests added:** 42 new tests across 4 files (19 core + 23 github)
- `packages/core/src/test/providerRegistry.test.ts` — 11 tests
- `packages/core/src/test/actionRegistry.test.ts` — 8 tests (7 + describe grouping)
- `packages/github/src/test/githubProvider.test.ts` — 10 tests
- `packages/github/src/test/startWorkAction.test.ts` — 13 tests

**Mock patterns:**
- `createMockProvider()` helper using vscode EventEmitter mock — enables `fireItems()` to simulate provider discovery events synchronously
- `vi.stubGlobal('fetch', mockFetch)` for mocking global fetch in GitHub provider tests
- `vi.mock('child_process')` with callback-style mock for `execFile` since StartWorkAction uses `promisify(execFile)`
- Reused `createMockStore()` pattern from workGraph.test.ts for ProviderRegistry tests

**Edge cases discovered:**
- ProviderRegistry `handleDiscoveredItems` is synchronous (calls async `createItem`/`updateItem` without awaiting) — used `vi.waitFor()` to handle async settling in tests
- StartWorkAction slug generation strips `#NNN: ` prefix, lowercases, replaces non-alphanumeric with hyphens, trims leading/trailing hyphens, truncates to 40 chars
- GitHubIssueProvider truncates issue body to 200 chars for description field
- Non-ok fetch responses return empty array (don't throw), so `onDidDiscoverItems` still fires with empty/partial results
- `workspace.workspaceFolders` can be `undefined` OR empty array — both need guarding

**Timer testing:**
- `vi.useFakeTimers()` / `vi.useRealTimers()` for periodic refresh tests — must restore real timers in each test to avoid interference

## Phase 2 Completion (2026-03-24)

**Status:** COMPLETE — Test suite expanded to 61 tests, all passing.
- Wrote 42 new tests across 4 files (providerRegistry, actionRegistry, githubProvider, startWorkAction)
- Total: 61 tests passing (19 existing core + 23 new core/github)
- Covered provider discovery, action invocation, GitHub REST API, git operations, edge cases (truncation, non-ok responses, async handling)

### Four-View Model Test Suite (2026-07-25)

**Tests added:** 57 new tests across 5 files (4 new + 1 extended)
- `packages/core/src/test/discoveredStateStore.test.ts` — 11 tests (CRUD, persistence, events, error handling)
- `packages/core/src/test/inboxTreeProvider.test.ts` — 13 tests (filtering by inboxState, treeItem rendering, refresh events)
- `packages/core/src/test/sourcesTreeProvider.test.ts` — 21 tests (hierarchical tree, groups, icons, all-state visibility)
- `packages/core/src/test/migration.test.ts` — 7 tests (provider-backed WorkItem migration, skip manual items, idempotency)
- `packages/core/src/test/providerRegistry.test.ts` — 5 new tests added (event firing, dismissed sticky, no WorkItem creation, getAllDiscoveredItems)

**Total suite: 121 tests passing (98 core + 23 GitHub).**

**Mock patterns:**
- Created helper mocks with `_fire()` and `_setItems()` for tree provider tests — avoids needing real ProviderRegistry/DiscoveredStateStore
- Used real filesystem (tmpdir) for DiscoveredStateStore tests (same pattern as jsonTaskStore.test.ts) — more reliable than mocking fs/promises
- `createMockProviderRegistry()` with backing Map<string, DiscoveredItem[]> and EventEmitter for tree provider isolation
- `createMockStateStore()` with backing Map<string, string> and EventEmitter for testing onDidChange subscriptions
- Migration tested by extracting the for-loop logic from extension.ts into a standalone `runMigration()` function

### Issue #231 — Sources Distinct Icons Test Coverage (2026-07-25)

**Tests updated:** 2 tests rewritten + 1 new test in `sourcesTreeProvider.test.ts`
- Renamed "should render non-accepted item with circle-outline icon" → "should render unseen item with circle-outline icon" (clearer intent)
- Updated dismissed test to assert `circle-slash` icon instead of `circle-outline`
- Added "should use distinct icons for accepted, dismissed, and unseen states" — collects all three icons into a Set and asserts `size === 3`

**Key pattern:** Use `stateStore.getState.mockReturnValue()` to cycle through states on the same node, then compare icon IDs via Set uniqueness. No need for separate nodes.

**File paths:**
- Production: `packages/core/src/views/sourcesTreeProvider.ts` (`switch (state)` selects icons: accepted→check, dismissed→circle-slash, unseen→circle-outline)
- Tests: `packages/core/src/test/sourcesTreeProvider.test.ts` (getTreeItem describe block)

**Suite metrics:** 865 tests passing (29 test files), 0 failures.

**Edge cases found:**
- DiscoveredStateStore: corrupted JSON on disk throws (not silently ignored) — only ENOENT is handled gracefully
- DiscoveredStateStore: `mkdir({ recursive: true })` creates nested storage directories on first write
- InboxTreeProvider: items with `state === undefined` AND `state === 'unseen'` both show in inbox (missing = unseen contract)
- SourcesTreeProvider: dismissed items show with `description: 'dismissed'` text and `circle-outline` icon (not `check`)
- SourcesTreeProvider: empty provider arrays are excluded from top-level tree (no empty provider nodes)
- Migration: items with providerId but no externalId are correctly skipped
- ProviderRegistry: handleDiscoveredItems does NOT call workGraph.createItem (critical design change verified)

## Test Architecture Learnings (Updated 2026-03-24)

### Helper Mock Patterns
- Helper mocks with `_fire()` and `_setItems()` allow tree provider tests to run in complete isolation from ProviderRegistry/DiscoveredStateStore
- Real filesystem (tmpdir) more reliable than fs/promises mocking for stateful store tests — reduces brittleness from mock state misalignment
- `createMockProviderRegistry()` and `createMockStateStore()` provide minimal interfaces sufficient for their consumers

### Discovered Item State Contracts
- Missing state (undefined in store) is semantically equivalent to 'unseen' — both filter to inbox
- Empty provider arrays are culled from top-level tree to avoid visual clutter (Sources shows only providers with items)
- Dismissed state is non-transient — provider refresh cannot clear it, only user action can (via accept)

### Migration Logic Independence
- Migration logic (`runMigration()`) extracted from extension.ts to standalone function for easier testing
- Migration must run before tree providers are registered, ensuring no race conditions on cold start
- Items with providerId but missing externalId are correctly skipped (malformed records from manual creation)

### Test Updates After Code Review Fixes (2026-03-25)

**Fixed 7 failing tests after Fenster's Critical and Important fixes:**

1. **providerRegistry.test.ts** — "fires onDidChangeDiscoveredItems" 
   - Issue: `handleDiscoveredItems` is async, test wasn't waiting
   - Fix: Used `vi.waitFor()` to wait for async settling
   - Learned: Async event handlers require waitFor in tests, even if they fire events synchronously

2. **githubProvider.test.ts** — "falls back to /issues?filter=assigned"
   - Issue: `externalId` format changed from `github-issue-<url>` to `owner/repo#number`
   - Fix: Updated expected values to match stable format
   
3. **githubProvider.test.ts** — "fires onDidDiscoverItems with correctly mapped"
   - Issue: Same externalId format change
   - Fix: Updated expected `externalId` to `owner/repo#10` format

4-7. **startWorkAction.test.ts** — 4 tests for branch/worktree creation
   - Issue: Production code now checks branch existence, uses path.join, checks fs.existsSync, rollback on failure
   - Fix: Added fs mock, updated git call count (3 instead of 2), used Windows path separators
   - Learned: Windows path.join produces backslashes — tests must match OS-specific paths
   - Added 3 new test cases: branch exists check, worktree dir exists check, rollback on failure

**Key patterns:**
- Windows path separators: Always use `\\` in test assertions on Windows (path.join behavior)
- Async event handlers: Use `vi.waitFor()` when testing async handlers that fire sync events
- Mock fs for filesystem checks: `vi.mock('fs')` with `existsSync` for directory existence tests
- Rollback testing: Verify cleanup actions (like branch deletion) when operations fail mid-process

## Test Updates After Code Review Fixes (2026-03-24)

**Status:** COMPLETE — 7 tests fixed, 3 new cases added.

After Fenster fixed Critical and Important issues from Keaton's code review, 7 tests were failing. The production code changes were correct — tests needed updating to match new behavior.

### Test Fixes

#### 1. Async Event Handler Testing Pattern

**File:** `packages/core/src/test/providerRegistry.test.ts`  
**Test:** "fires onDidChangeDiscoveredItems"  
**Issue:** `handleDiscoveredItems` became async but tests expected synchronous behavior.  
**Solution:** Use `vi.waitFor()` for async settling:
```typescript
provider.fireItems([{ externalId: '1', title: 'Item' }]);
await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
```
**Decision:** Always use `vi.waitFor()` when testing async event handlers, even if events fire synchronously.

#### 2. Stable ExternalId Format

**Files:** `packages/github/src/test/githubProvider.test.ts` (2 tests)  
**Tests:**
- "falls back to /issues?filter=assigned"
- "fires onDidDiscoverItems with correctly mapped"

**Issue:** GitHub provider externalId format changed from `github-issue-<url>` to `owner/repo#number`.  
**Solution:** Updated expected values to match stable format.  
**Impact:** More stable, human-readable, and matches GitHub's native reference format.

#### 3. Windows Path Handling

**File:** `packages/github/src/test/startWorkAction.test.ts` (1 test updated)  
**Issue:** `path.join()` produces backslashes on Windows, but tests used forward slashes.  
**Solution:** Match OS-specific path separators in test assertions:
```typescript
// Windows
expect(Uri.file).toHaveBeenCalledWith('\\mock\\issue-123-fix-bug');

// Production code uses path.join for platform independence
const worktreePath = path.join(path.dirname(repoPath), branchName);
```
**Decision:** Test assertions must match OS-specific paths when testing path operations.

#### 4. Git Operation Sequencing with Preconditions

**File:** `packages/github/src/test/startWorkAction.test.ts` (4 tests)  
**New behavior:**
1. Check if branch exists (`git branch --list`)
2. Create branch (`git branch`)
3. Check if worktree directory exists (`fs.existsSync`)
4. Create worktree (`git worktree add`)
5. On failure: rollback by deleting branch

**Tests added:**
- Branch already exists → show error, no branch/worktree creation
- Worktree directory exists → show error, rollback branch
- Worktree creation fails → rollback branch deletion

**Decision:** Test the full operation sequence including guards and rollback logic, not just the happy path.

### Test Suite Status

- **Before:** 121 tests (7 failing)
- **After:** 124 tests (all passing)
- **Added:** 3 new test cases for branch/directory existence checks and rollback
- **Core tests:** 98 passing
- **GitHub tests:** 26 passing (updated from 23)

### Patterns for Future Test Updates

1. **Async handlers:** Always use `vi.waitFor()` for async settling
2. **OS paths:** Match platform-specific path separators (backslash on Windows)
3. **Guards and rollback:** Test error conditions and cleanup logic
4. **Mock fs:** Use `vi.mock('fs')` for filesystem existence checks
5. **Call count:** Update expected git call counts when guards are added (2 → 3 for branch/worktree ops)

### Related Files

**Tests updated:**
- `packages/core/src/test/providerRegistry.test.ts`
- `packages/github/src/test/githubProvider.test.ts`
- `packages/github/src/test/startWorkAction.test.ts`

**Production files:**
- `packages/core/src/services/providerRegistry.ts`
- `packages/github/src/githubProvider.ts`
- `packages/github/src/startWorkAction.ts`

### Decision Record

Test patterns documented in `.squad/decisions.md` under "Test Update Patterns" (2026-03-25).

### ADO Work Item State Exclusion Testing (2025-05-16) — SUPERSEDED

**Note:** This initial approach (hardcoding `Resolved` and `Done` in WIQL) was replaced by state-category-based filtering. See "ADO State Category Filtering Tests" below for the current approach. WIQL now only excludes `Closed` and `Removed` for performance; all other non-active states are filtered via the ADO Work Item Type States API.

### ADO State Category Filtering Tests (2025-05-16, Issue #178)

**Issue:** ADO provider refactoring to use state category API for filtering terminal work items.

**Design:** Production code (Fenster) is moving state filtering from WIQL query to post-fetch filtering using ADO Work Item Type States API. WIQL will keep only basic `Closed` and `Removed` exclusions for performance. After detail fetch, provider calls states API per work item type to get state categories (`Completed`, `Removed`, `Resolved` = terminal) and filters items before publishing.

**Tests added:** 9 new tests in `state category filtering` describe block:

1. **Updated WIQL test** — Changed existing test to verify WIQL only excludes `Closed` and `Removed` (NOT `Resolved` or `Done`)
2. **Filters out work items in terminal state categories** — Mock WIQL returns 3 items (Active, Resolved, New). States API maps Resolved→Resolved category. Expect only Active and New published.
3. **Handles multiple work item types** — Bug and User Story with different terminal states. Verify correct per-type filtering.
4. **Caches state definitions** — Call refresh twice. Verify states API called only once per (project, type) pair.
5. **Fails open on states API error** — Mock 500 error for one type. Items of that type kept visible, other types filtered correctly.
6. **Fails open on network error** — States API throws network error. Items kept (not filtered).
7. **Fails open on unparseable JSON** — States API response.json() throws. Items kept.
8. **Handles org-level query** — Provider with empty projects array. Verify states API URL uses project from work item detail.

**Helper added:** `createStatesResponse()` to mock ADO states API responses.

**Updated helper:** Added `state` parameter to `createWorkItemDetail()` (defaults to 'Active').

**Test results:** 132 tests total (102→132, +30). **16 tests currently failing:**
- **9 new state filtering tests fail** — Expected. Production code not yet implemented by Fenster.
- **7 pre-existing tests now fail** — Also expected. Tests need updating after Fenster's refactor completes:
  - 3 tests expect 2 fetch calls, now get 3 (states API added)
  - 4 tests expect items, now get empty arrays (items filtered out by new logic)

**Failure patterns:**
- "fetches assigned work items via WIQL and detail APIs" — expects 2 fetch calls, gets 3 (states API)
- "strips HTML tags from description" — items[0] is undefined (filtered out)
- "truncates description to 200 chars" — items[0] is undefined (filtered out)
- "handles detail batch network error" — expects 1 item, gets 0 (filtered out)
- "handles work item with undefined description" — items[0] is undefined (filtered out)
- "handles work item with empty description" — items[0] is undefined (filtered out)
- State filtering tests — all expect filtering logic that isn't implemented yet

**Status:** Tests written per spec. Waiting for Fenster to complete production implementation. Tests document expected behavior and will pass once states API integration is complete.

### ADO State Category Filtering Test Fixes (2025-05-16, Issue #178)

**Issue:** After Fenster's state-category-based filtering implementation, 16 tests were failing due to missing mock implementations and incorrect assertions.

**Root cause:** The `filterActiveItems` method now calls `fetchTerminalStates`, which makes a `fetch` call for each unique (project, workItemType) pair. Existing tests didn't mock this call, and new state category filtering tests had incorrect assertions for `externalId` and `title` formats.

**Fix strategy:** Added a default `mockImplementation` fallback in `beforeEach` blocks of both test files. The fallback handles unmocked states API calls and throws on unexpected URLs for fast failure diagnostics:
```typescript
mockFetch.mockImplementation(async (url: string) => {
  if (typeof url === 'string' && url.includes('/workitemtypes/') && url.includes('/states')) {
    return { ok: true, json: async () => ({ count: 0, value: [] }) };
  }
  throw new Error(`Unexpected fetch call in test: ${String(url)}`);
});
```

**Changes made:**

1. **Added fallback mock implementation** in both test files (`adoWorkItemProvider.test.ts` and `adoWorkItemProvider.extended.test.ts`)
   - Catches states API calls that aren't explicitly mocked
   - Returns empty states → no items filtered → existing behavior preserved
   - Tests with explicit `mockResolvedValueOnce` for states API take priority

2. **Updated `toHaveBeenCalledTimes` assertions** to account for additional states API calls:
   - "fetches assigned work items via WIQL and detail APIs": 2 → 4 calls (2 work item types: User Story + Bug)
   - "fetches work item details in batches of 200": 4 → 5 calls (1 WIQL + 3 batches + 1 states)

3. **Fixed assertions in new state category filtering tests:**
   - `externalId` format: Changed `'myorg/MyProject#1'` → `'MyProject/1'` (format is `${project}/${id}`)
   - `title` format: Changed `'Bug Active'` → `'Bug 1: Bug Active'` (format is `${type} ${id}: ${title}`)
   - Fixed 5 test assertions across 3 tests (filters out terminal states, handles multiple types, fail-open tests)

4. **Fixed double-slash check in org-level query test:**
   - Changed from checking `not.toContain('//')` (fails for `https://`)
   - To regex check `not.toMatch(/[^:]\/\//)` (catches path segment issues like `//_apis`)

**Test results:** All 132 ADO tests passing. Full test suite: 434 tests passing (132 ADO + 169 GitHub + 133 shared).

**Key learning:** When adding new API calls to production code, use `mockImplementation` as a default fallback in tests rather than updating every individual test. This provides safe defaults while allowing specific tests to override with `mockResolvedValueOnce`.

### AiWalkthroughAction Tests (Issue #12)

**Tests added:** 14 tests in `packages/ai-reviewer/src/test/aiWalkthroughAction.test.ts`

**Scope:** The walkthrough action prepares a git worktree via RepoManager and opens the `@walkthrough` chat participant. Tests cover this flow, not the chat participant itself (tested separately in `walkthroughParticipant.test.ts`).

**What's tested:**
1. Identity — `id` is `'ai-reviewer.walkthrough'`, `label` is `'AI Walkthrough'`
2. canRun — returns true for GitHub PR URLs, false for non-PR URLs, URLs with queries/fragments
3. run — calls `repoManager.ensureWorktree` with the PR URL
4. run — opens chat with correct `@walkthrough` query after preparing worktree
5. run — shows error message when ensureWorktree fails
6. run — does nothing when item has no URL
7. run — respects cancellation token

**Pattern:** Uses a mock RepoManager injected via constructor. No base class test duplication — shared PR URL parsing is in `prUrl.ts`, tested via `repoManager.test.ts`.
### Dismissed Items Persistence Tests (2025-01-30, Issue #189)

**Issue:** Dismissed items reappearing in inbox after provider refresh. Need tests to verify dismissed state persists through multiple refresh cycles.

**Context:** The `ProviderRegistry.handleDiscoveredItems` method respects existing inbox states (unseen/accepted/dismissed) and only sets state to 'unseen' for newly discovered items. The `InboxTreeProvider` filters items based on `stateStore.getState()`, showing only items where state is `undefined` or `'unseen'`. Tests needed to verify this behavior works correctly across refresh cycles.

**Tests added:** 13 new tests across 2 files

**`providerRegistry.test.ts`** — 5 new tests in "issue #189: dismissed items reappearing in inbox" describe block:

1. **should NOT reset dismissed item to unseen after provider refresh** — Verify dismissed state persists when provider re-emits same items
2. **should maintain dismissed state through multiple provider refresh cycles** — Verify 5 consecutive refreshes don't reset dismissed state
3. **should show only unseen items when mix includes dismissed items** — Verify filtering when items have mixed states (unseen/accepted/dismissed)
4. **should add new items as unseen while preserving dismissed items** — Verify new items get 'unseen' state without affecting dismissed items
5. **should preserve dismissed state even when item data changes** — Verify dismissed state persists when provider updates title/description

**`inboxTreeProvider.test.ts`** — 8 new tests in "issue #189: dismissed items not appearing in inbox view" describe block:

1. **should NOT show dismissed items in inbox after provider refresh** — Verify dismissed items filtered from inbox tree
2. **should NOT include dismissed items in group counts** — Verify group unseen counts exclude dismissed items
3. **should hide group node when all items are dismissed** — Verify group nodes hidden when all children dismissed
4. **should hide provider node when all items are dismissed** — Verify provider nodes hidden when all items dismissed
5. **should maintain dismissed filtering through provider refresh cycles** — Verify filtering survives multiple refreshes
6. **should show new items while hiding dismissed ones after provider refresh** — Verify new items appear alongside dismissed items
7. **should correctly count mixed states (unseen/accepted/dismissed)** — Verify count accuracy with mixed states
8. **should update view when item transitions from unseen to dismissed** — Verify reactive update when state changes

**Test patterns:**
- Used `stateStore._set()` helper to simulate dismissed state before provider refresh
- Used `stateStore.setStates.mockClear()` to verify no state updates after dismissed items re-emitted
- Used `vi.waitFor()` for async event handler settling in providerRegistry tests
- Used `vi.advanceTimersByTime(DEBOUNCE_MS)` for debounced refresh events in inboxTreeProvider tests
- Verified both data updates (in ProviderRegistry) and view filtering (in InboxTreeProvider) independently

**Edge cases covered:**
- Multiple refresh cycles (5 iterations)
- Mixed states (unseen/accepted/dismissed) in same provider
- New items added alongside dismissed items
- Item data changes (title/description) while dismissed
- Group nodes with all items dismissed
- Provider nodes with all items dismissed
- State transitions triggering view updates

**Test results:** All 13 new tests pass on first run (121 total → 134 total tests passing). The tests validate the fix and document the expected behavior so regressions are caught if dismissed items are resurfaced again.

**Key learning:** The bug in issue #189 was present in the codebase. The root cause was explicit resurface logic (`resurfaceDismissed`) that reset dismissed items when they were rediscovered, causing them to reappear. The correct fix was to remove that resurface behavior; the tests now document the expected dismissed-state preservation and guard against future regressions.

### Editor Metadata Section Tests (Issue #217)

**Tests added:** 10 new tests in `packages/core/src/test/editorPanelHtml.test.ts` under `metadata section` describe block.

**What's tested:**
1. Metadata section exists with `class="metadata"` and `aria-label`
2. State value rendered in metadata (uses display label, e.g. `InProgress` → `"In Progress"`)
3. All 5 WorkItemState values render correct display labels
4. Correct badge CSS class applied per state (badge-new, badge-inprogress, badge-paused, badge-done, badge-archived)
5. Provider name shown when both `providerId` and `providerLabel` are provided
6. Provider row hidden when `providerLabel` is not supplied (even with `providerId`)
7. Provider row hidden for manual items (no `providerId`)
8. Created timestamp rendered as formatted date (not raw epoch)
9. Updated timestamp rendered as formatted date (not raw epoch)
10. HTML entities escaped in provider label (XSS prevention)

**Concurrent development challenge:** Fenster was actively editing `editorPanelHtml.ts` during test writing. The implementation changed between test runs (state label toggling between raw enum and display format, provider condition changing between `providerId`-only and `providerId && providerLabel`). Required re-reading source after each failed run to match the current implementation.

**Key patterns:**
- `getMetadataSection()` helper extracts metadata `<dl>` content for targeted assertions, avoiding false positives from other parts of the HTML
- `EditorHtmlOptions` gained optional `providerLabel` parameter — provider row requires both `providerId` AND `providerLabel`
- `stateLabel()` maps `InProgress` → `"In Progress"` (only non-trivial mapping); all other states use raw enum value
- Timestamp tests use dates from 2024 and verify the year appears while raw epoch does NOT appear

**Test results:** 875 tests passing (29 test files). 10 new tests, 9 existing tests unchanged.
### Issue #223 — Dead CSS & Helper Cleanup (2026-07-22)

**Task:** Verify tests after Fenster removed dead CSS (`.actions`, `button.primary`, `button.secondary`) from `editorPanelHtml.ts` and dead helper functions (`getNonce()`, `escapeHtml()`, `escapeAttr()`) from `workItemEditorPanel.ts`.

**Test changes:**
- Updated 2 test names in `workItemEditorPanel.test.ts` to remove references to deleted functions:
  - `'escapes special characters in title (via escapeAttr)'` → `'escapes special characters in title'`
  - `'escapes special characters in notes (via escapeHtml)'` → `'escapes special characters in notes'`
- No test logic changes needed — the tests validate HTML output behavior, not the removed functions directly
- `editorPanelHtml.test.ts` (9 tests) unaffected — tests the live `getEditorPanelHtml()` which retains its own `escapeHtml`/`escapeAttr`

**Key files:**
- `packages/core/src/test/workItemEditorPanel.test.ts` — integration tests for the editor panel
- `packages/core/src/test/editorPanelHtml.test.ts` — unit tests for HTML generation (unchanged)

**Test results:** 864 passed, 29 test files, 0 failures.

**Key learning:** When dead code is removed, test names referencing that code become misleading even if the test logic is still valid. Update test names to reflect current architecture — in this case, the escaping now lives solely in `editorPanelHtml.ts`, not in `workItemEditorPanel.ts`.

## Issue #227: Queue View Provider Labels (2026-04-13)

**Status:** COMPLETE — Provider labels now display in queue view instead of raw IDs  
**Tester:** Hockney

### Summary
Added 6 comprehensive test cases to `queueTreeProvider.test.ts` covering the queue view provider label display fix. Tests verify label rendering, provider lookup, and fallback behavior.

### Files Modified
- `packages/core/src/test/queueTreeProvider.test.ts` — 6 new tests added

### Test Coverage
Tests verify:
1. Queue tree items display correct provider labels
2. Label lookup falls back gracefully when provider not found
3. Label formatting and display consistency
4. Integration with `getProviderLabel()` method from base provider
5. Multiple provider types (GitHub, ADO) correctly labeled
6. Edge case: items with missing provider IDs

### Test Infrastructure Notes
- Used the existing `createMockStore()` pattern from Phase 2 alongside a local `createMockProviderRegistry()` helper in `queueTreeProvider.test.ts`
- No new test infrastructure required
- All assertions validate both display layer and provider lookup mechanism

### Result
- Tests added: 6 new test cases
- Suite status: 870 tests passing (864 existing + 6 new)
- Build: ✅ Passes
- Commit: `f667e7d` — "Fix queue view to show provider label instead of raw ID (#227)"


### Issue #229 — Emoji Description Tests Updated (2026-04-12)

**Context:** Issue #229 replaced emoji characters in tree view descriptions with plain text for consistent rendering.

**Files modified:**
- `packages/core/src/test/focusTreeProvider.test.ts` — Updated assertion: `'⏸ paused'` → `'paused'`
- `packages/core/src/test/historyTreeProvider.test.ts` — Updated assertions: `'✓ done'` → `'done'`, `'📦 archived'` → `'archived'`

**Pattern:** Description assertions in tree provider tests live in `getTreeItem`-related describe blocks. When production description format changes, update both the assertion value and the `it()` label to match.

**Test suite:** 864 tests passing (29 files), 0 failures.
