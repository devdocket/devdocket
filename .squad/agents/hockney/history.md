# Hockney — Tester — History

## Core Context

WorkCenter is a VS Code extension for managing work items. Phase 1 is complete:
- Queue view (new items) and Focus view (in-progress items) as tree data providers
- Manual work item creation via input box, editing via webview panel with auto-save
- 7-state WorkItem model (New, Triaged, InProgress, Blocked, WaitingOn, Done, Archived)
- WorkGraph service: in-memory Map, event-driven, ITaskStore abstraction
- JsonTaskStore: one JSON file per item in globalStorageUri
- 19 passing vitest tests
- esbuild bundler, TypeScript strict mode

Test infrastructure:
- vitest with `vitest.config.ts`
- VS Code module mocked in `src/test/__mocks__/`
- Test files: `src/test/workGraph.test.ts`, `src/test/jsonTaskStore.test.ts`
- Run: `npm test` (vitest run), `npm run test:watch` (vitest watch)

Key files:
- `src/models/workItem.ts` — model + state enum (7 states: New, Triaged, InProgress, Blocked, WaitingOn, Done, Archived)
- `src/services/workGraph.ts` — core service with createItem, updateItem, transitionState, deleteItem
- `src/storage/jsonTaskStore.ts` — file-per-item persistence

## Learnings

### Phase 2 Test Writing (2025)

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
