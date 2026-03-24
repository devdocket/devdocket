# Decision: Phase 2 Test Strategy

**Author:** Hockney (Tester)  
**Date:** 2025-07-17  
**Status:** Applied

## Context
Phase 2 introduced ProviderRegistry, ActionRegistry (core), GitHubIssueProvider, and StartWorkAction (github). All needed test coverage from scratch.

## Decisions

1. **Mock helpers per test file** — each test file is self-contained with its own helpers (`createMockProvider`, `createMockAction`, `createWorkItem`). This avoids cross-file coupling and makes tests easy to read in isolation.

2. **`vi.stubGlobal('fetch')` over `vi.mock`** — for GitHubIssueProvider, global fetch stubbing is simpler and mirrors how the production code uses the native `fetch` API.

3. **Callback-style `execFile` mock** — StartWorkAction uses `promisify(execFile)`, so the mock must call the callback. `vi.mock('child_process')` with a custom factory returning a callback-calling function handles this cleanly.

4. **`vi.waitFor()` for async settling in ProviderRegistry** — `handleDiscoveredItems` fires synchronously but calls async `createItem`/`updateItem`. Rather than coupling tests to implementation timing, `vi.waitFor()` waits for the expected state to appear.

## Alternatives Considered
- Shared test-utils module: rejected to keep github and core packages decoupled
- Mocking WorkGraph directly in ProviderRegistry tests: rejected in favor of using a real WorkGraph with mock store to test integration behavior
