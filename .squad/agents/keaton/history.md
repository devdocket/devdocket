# Keaton — Lead — History

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
- `src/storage/jsonTaskStore.ts` — persistence
- `src/views/` — inboxTreeProvider, focusTreeProvider, workItemEditorPanel
- `src/commands/commands.ts` — all command registrations
- `src/extension.ts` — activation entry point

## Learnings

### 2025-07-18 — Four-View Architecture Review
- Reviewed Matt's four-view proposal (Inbox → Queue → Focus → Sources) replacing the current two-view model
- **Key decision:** Approved the overall direction but flagged three items needing refinement before Fenster implements:
  1. State model: Replace `inboxVisible`/`dismissed`/`notified` booleans with single `inboxState: 'unseen' | 'seen' | 'accepted' | 'dismissed'` enum
  2. DiscoveredItemStore must persist full item data (title, desc, url, group), not just state flags — otherwise cold-start leaves Inbox/Sources empty
  3. Migration path needed: existing WorkItems with `providerId`+`externalId` must seed DiscoveredItemStore as `inboxState: 'accepted'`
- ProviderRegistry contract change approved (pre-1.0, no external consumers)
- WorkItemState enum unchanged — discovery lifecycle uses its own `inboxState` enum
- DiscoveredItemRecords are never deleted by provider refresh (only added/updated) — prevents dismissed items from re-spamming Inbox
- Naming: rename existing `InboxTreeProvider` → `QueueTreeProvider` first, THEN create new `InboxTreeProvider`
- Decision record: `.squad/decisions/inbox/keaton-four-view-review.md`
- Key files reviewed: `types.ts`, `providerRegistry.ts`, `workItem.ts`, `inboxTreeProvider.ts`, `focusTreeProvider.ts`, `extension.ts`, `package.json`, `workGraph.ts`, `commands.ts`, `workCenterApi.ts`, `githubProvider.ts`

## Phase 3 Four-View Implementation (2026-03-24)

**Status:** COMPLETE — Implementation approved and executed by Fenster, tests verified by Hockney.

### Implementation Outcomes
- Fenster delivered all 10 implementation steps on schedule
- DiscoveredStateStore correctly implements ENOENT/mkdir pattern consistent with JsonTaskStore
- ProviderRegistry refactoring successful: no longer creates WorkItems, stores in Map<string, DiscoveredItem[]>
- Tree provider separation working as designed: InboxTreeProvider (unseen), QueueTreeProvider (New WorkItems), SourcesTreeProvider (hierarchical), FocusTreeProvider (in-progress)
- Migration logic runs on activation, correctly seeds existing WorkItems with providerId+externalId as 'accepted'
- GitHub provider adds `group: owner/repo` field enabling Sources grouping

### Test Coverage Validation
- Hockney's 57 new tests verify all edge cases specified in architecture review:
  - Dismissed items sticky contract ✓
  - No WorkItem creation in ProviderRegistry ✓
  - Missing=unseen state contract ✓
  - Empty provider nodes culled from tree ✓
  - Migration skips malformed records ✓
- Total test suite: 121 passing (98 core + 23 GitHub)

## PR #1 Code Review & Approval (2026-03-24)

**Status:** APPROVED — Re-reviewed after fixes, approved for merge.

Conducted comprehensive code review of PR #1 (Four-View Model + Phase 2 Tests implementation).

### Review Process

**Pass 1 (Rejected):** Initial review found 15 issues requiring fixes:
- 7 Critical (C1-C7): loading flags, async writes, error handling, cache, git safety, paths
- 8 Important (I1-I8): auth handling, user errors, timing, immutability, rollback, defensive checks, stable IDs, test mocks

**Pass 2 (Approved):** Re-review after Fenster's fixes across:
- All 15 review issues (C1-C7, I1-I8) resolved
- 32 additional Copilot review comments from 4 rounds addressed
- Hockney's test updates verified (7 tests fixed + 3 new cases)
- All 124 tests passing

### Critical Issues Found (7)

- **C1:** Loading flag not cleared on error paths in discovery
- **C2:** Async state writes not awaited in loops
- **C3:** Migration error handling incomplete (no per-item try-catch)
- **C4:** API type safety using truthiness instead of typeof
- **C5:** In-memory cache implementation missing for storage
- **C6:** Git branch safety checks absent before creation
- **C7:** Path construction using string concatenation instead of path.join

### Important Issues Found (8)

- **I1:** GitHub auth cancellation not handled (no .catch guard)
- **I2:** User-facing errors only logged to console
- **I3:** View message timing race with provider registration
- **I4:** Item updates mutating in-place instead of cloning
- **I5:** Multi-step operations lacking rollback logic
- **I6:** Defensive filesystem checks missing for worktree
- **I7:** ExternalId using mutable URLs instead of stable identifiers
- **I8:** Mock fs not used for fs.existsSync() tests (resolved as test pattern, not code issue)

### Approved Fix Patterns

Keaton verified Fenster's fixes adhered to established patterns:

1. **In-memory cache** (C5) — JsonTaskStore uses Map as source of truth
2. **Git operation safety** (C6) — precondition checks + rollback on failure
3. **Stable external IDs** (C7) — owner/repo#number format instead of URLs
4. **User-facing errors** (I2) — accumulate failures, single user notification
5. **Immutable updates** (I4) — clone before mutation to prevent inconsistent state

### Test Coverage Validation

Hockney's updates verified all code changes:
- 7 tests fixed for production behavior changes
- 3 new test cases added for enhanced coverage
- Test patterns documented for future reference
- Final suite: 124 tests (98 core + 26 GitHub), all passing

### Cross-Team Coordination Summary

| Agent | Work | Status |
|-------|------|--------|
| Fenster | Fix C1-C7, I1-I8, 32 Copilot comments | ✓ Complete (47 fixes) |
| Hockney | Update 7 tests, add 3 cases | ✓ Complete (124 tests passing) |
| Copilot | 4 review rounds | ✓ Complete (32 comments addressed) |

### Approval Decision

PR #1 approved for merge. Ready for integration into dev branch.

### Decision Records

Detailed findings and patterns documented in:
- `.squad/decisions.md` — "Code Review Fix Patterns" (2026-03-24)
- `.squad/decisions.md` — "Test Update Patterns" (2026-03-25)
- `.squad/orchestration-log/` — Keaton, Fenster, Hockney review logs


