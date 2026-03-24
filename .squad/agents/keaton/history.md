# Keaton — Lead — History

## Core Context

WorkCenter is a VS Code extension for managing work items. Phase 1 is complete:
- Queue view (new items) and Focus view (in-progress items) as tree data providers
- Manual work item creation via input box, editing via webview panel with auto-save
- 7-state WorkItem model (New, Triaged, InProgress, Blocked, WaitingOn, Done, Archived)
- WorkGraph service: in-memory Map, event-driven, ITaskStore abstraction
- JsonTaskStore: one JSON file per item in globalStorageUri
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

### Discovered Implementation Details
- InboxState enum (`'unseen' | 'accepted' | 'dismissed'`) implemented exactly as reviewed
- Cold-start gap addressed: No persisted item data works because provider refresh happens immediately on activation
- Event-driven model (both DiscoveredStateStore and ProviderRegistry fire onDidChange) ensures view synchronization
- Helper mocks in tests isolate tree providers from storage/registry dependencies, improving maintainability
