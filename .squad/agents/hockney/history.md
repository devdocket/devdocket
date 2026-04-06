# Hockney — Tester — History

## Core Context

WorkCenter is a VS Code extension for managing work items. Phase 1 is complete:
- Queue view (new items) and Focus view (in-progress items) as tree data providers
- Manual work item creation via input box, editing via webview panel with auto-save
- 6-state WorkItem model (New, InProgress, Blocked, WaitingOn, Done, Archived)
- WorkGraph service: in-memory Map, event-driven, ITaskStore abstraction
- JsonTaskStore: all items persisted in a single `workitems.json` file in globalStorageUri
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


