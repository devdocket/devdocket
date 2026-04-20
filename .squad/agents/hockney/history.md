# Hockney — Tester — History

## Core Context

DevDocket is a VS Code extension monorepo for managing work items. Packages: `core`, `github`, `ado`, `start-git-work`, `shared`, `ai-reviewer`.

### Test Infrastructure
- **Framework:** vitest with `vitest.config.ts` per package
- **VS Code mocking:** Custom mock in `src/test/__mocks__/vscode.ts` aliased via vitest config. Tests run in Node.js, never load real vscode module.
- **GitHub package mock:** `packages/github/src/test/__mocks__/vscode.ts` — adds `authentication`, `workspace`, `extensions` mocks
- **Run commands:** `npm test` (vitest run), `npm run test:watch` (vitest watch)
- **Current test count:** ~1071+ tests across 30+ test files

### Established Test Patterns
- **`vi.waitFor()` for async settling:** Always use when testing async event handlers, even if events fire synchronously. Prevents timing assumptions.
- **`vi.stubGlobal('fetch', mockFetch)`:** Simpler than vi.mock for providers using global fetch.
- **Callback-style `execFile` mock:** Matches production code's `promisify(execFile)` pattern.
- **`vi.useFakeTimers()` / `vi.useRealTimers()`:** For periodic refresh tests. Must restore real timers in each test.
- **Real filesystem (tmpdir):** More reliable than fs/promises mocking for stateful store tests.
- **Mock helpers per test file:** Each test self-contained, avoids cross-file coupling.
- **`createMockProvider()`:** Uses vscode EventEmitter mock with `_fire()` / `_setItems()` for tree provider isolation.
- **`createMockProviderRegistry()`:** Backing `Map<string, DiscoveredItem[]>` + EventEmitters for tree provider tests.
- **`createMockStateStore()`:** Backing `Map<string, string>` + EventEmitter for state change subscriptions.
- **`createMockStore()`:** Reused from workGraph.test.ts for ProviderRegistry tests.
- **OS-specific path separators:** Windows `path.join` produces backslashes — test assertions must match.
- **Mock fs for filesystem checks:** `vi.mock('fs')` with `existsSync` for directory existence tests.
- **Git operation sequencing tests:** Test full sequence including guards (precondition checks) and rollback logic.
- **Default `mockImplementation` fallback:** For new API calls in production, provide safe defaults in beforeEach rather than updating every test individually.
- **`vi.advanceTimersByTime(DEBOUNCE_MS)`:** For debounced refresh events in tree provider tests.
- **Context key value verification:** Use `Object.fromEntries(setContextCalls.map(...))` to build key→value map from `executeCommand` mock calls.

### Key Test Files
- `packages/core/src/test/workGraph.test.ts` — core WorkGraph tests including state transitions
- `packages/core/src/test/providerRegistry.test.ts` — provider discovery, health, dismissed persistence
- `packages/core/src/test/discoveredStateStore.test.ts` — CRUD, persistence, events, error handling
- `packages/core/src/test/inboxTreeProvider.test.ts` — filtering by inboxState, rendering, refresh
- `packages/core/src/test/sourcesTreeProvider.test.ts` — hierarchical tree, groups, icons
- `packages/core/src/test/migration.test.ts` — provider-backed WorkItem migration
- `packages/core/src/test/editorPanelHtml.test.ts` — HTML generation, security, metadata
- `packages/core/src/test/workItemEditorPanel.test.ts` — editor panel integration
- `packages/core/src/test/viewLayout.test.ts` — layout toggle, LayoutState
- `packages/core/src/test/extension.test.ts` — activation, context keys, config
- `packages/core/src/test/focusTreeProvider.test.ts` — focus view title resolution
- `packages/core/src/test/historyTreeProvider.test.ts` — history view title resolution
- `packages/core/src/test/queueTreeProvider.test.ts` — queue view labels, title resolution
- `packages/github/src/test/githubProvider.test.ts` — GitHub REST API, externalId format
- `packages/github/src/test/startWorkAction.test.ts` — git branch/worktree operations
- `packages/ado/src/test/adoWorkItemProvider.test.ts` — ADO WIQL, state-category filtering
- `packages/ai-reviewer/src/test/walkthroughParticipant.test.ts` — chat participant, phase signals
- `packages/ai-reviewer/src/test/aiWalkthroughAction.test.ts` — walkthrough action flow

### Edge Cases & Contracts
- Missing state (undefined in store) is semantically equivalent to 'unseen' — both filter to inbox
- Empty provider arrays culled from top-level Sources tree
- Dismissed state non-transient — only user action (accept) can clear it
- Migration skips items with providerId but missing externalId
- `DiscoveredStateStore` corrupted JSON throws (only ENOENT handled gracefully)
- `mkdir({ recursive: true })` creates nested storage directories on first write
- ProviderRegistry `handleDiscoveredItems` does NOT call `workGraph.createItem`
- `EditorHtmlOptions` requires both `providerId` AND `providerLabel` for provider row
- `stateLabel()` maps `InProgress` → `"In Progress"` (only non-trivial mapping)
- HTML uses `escapeHtml()` for text content, `escapeAttr()` for attribute values (different escape sets)

### Completed Test Suites
- **#275:** 11 tests for History→Queue transitions (state membership, sort ordering, event firing, repeated moves)
- **#273:** Verified tree node counts pattern across all views
- **#252:** 7 tests for walkthrough `provideFollowups` + `lastFile` phase
- **#231:** 3 tests for Sources view distinct icons (accepted/dismissed/unseen)
- **#230:** 10 tests for layout toggle (edge cases, LayoutState, context key values)
- **#229:** Updated emoji assertions to plain text
- **#227:** 6 tests for queue view provider labels
- **#223:** Test name updates for dead helper cleanup
- **#222:** Verified no layout CSS assertions in existing tests
- **#221:** 3 tests for contextual editor heading
- **#219:** 3 tests for source URL link (button, missing URL, XSS)
- **#217:** 10 tests for editor metadata section (state badges, provider, timestamps, XSS)
- **#216:** 5 tests for provider description (render, omit, empty, XSS, read-only)
- **#215:** 19 tests for dynamic title resolution across Queue/Focus/History
- **#189:** 13 tests for dismissed items persistence (registry + inbox tree view)
- **#178:** 9 state-category filtering tests + 16 pre-existing test fixes
- **#12:** 14 tests for AiWalkthroughAction flow
- **Phase 2:** 42 tests (providerRegistry, actionRegistry, githubProvider, startWorkAction)
- **Four-view:** 57 tests (discoveredStateStore, inboxTreeProvider, sourcesTreeProvider, migration)
- **Code review fixes:** 7 tests fixed + 3 new for PR #1

> Full issue-level test details archived to `history-archive.md`

## Learnings

### 2026-04-17 Round 1 — Test Support for Parallel Sprint

**Issue #275 tests completed:** Wrote 11 new tests in `packages/core/src/test/workGraph.test.ts` supporting Fenster's History→Queue state transition work. Tests validate Queue membership, sort ordering, and event firing. All 1071 tests pass.

**Pattern:** Concurrent test writing enabled Fenster to implement two features in parallel while Hockney validated the more complex state transitions (#275) with full test coverage.

**Multi-worktree workflow confirmed:** Worked in dedicated worktree on branch `squad/275-history-to-queue` while main worktree was on different branch.

### 2026-04-22 — PR #327 Cancellation Test Coverage (Issue #300)

**44 new cancellation tests** across 5 test files covering the CancellationToken → AbortSignal wiring from PR #327. Test files:
- `packages/github/src/test/githubProvider.cancellation.test.ts` — 13 tests
- `packages/github/src/test/githubMyPrsProvider.cancellation.test.ts` — 9 tests
- `packages/github/src/test/githubPrReviewProvider.cancellation.test.ts` — 8 tests
- `packages/ado/src/test/adoWorkItemProvider.cancellation.test.ts` — 7 tests
- `packages/ado/src/test/adoPrReviewProvider.cancellation.test.ts` — 7 tests

**Key scenarios tested:**
1. AbortSignal is passed to every `fetch()` call when CancellationToken is provided
2. Mid-flight cancellation: token fires during fetch → AbortError propagates correctly
3. No items published on abort (preserves previous provider state)
4. AbortError logged at debug level, not error level
5. Worker pool abort: worker loops stop early when signal is aborted
6. cancelListener disposed in finally block (both success and abort paths)
7. `_isRefreshing` guard resets after abort so subsequent refresh can proceed
8. Already-cancelled token: early return without fetch
9. Pagination abort: stops fetching further pages when aborted mid-pagination
10. No partial results published when abort happens during multi-repo fetch

**Mock pattern: `createMockCancellationToken()`** — Creates a token with working `onCancellationRequested` callback and trackable `disposeStubs`. Mirrors real vscode.CancellationToken behavior. Returns `{ token, cancel, disposeStubs }`.

**Key behavioral difference discovered:** GitHub providers (via BaseGitHubProvider) do NOT fire empty items on early cancellation — they just return. ADO providers DO fire `[]` on pre-fetch cancellation. Both are correct for their respective patterns. AbortError during fetch does NOT publish items in either package.
