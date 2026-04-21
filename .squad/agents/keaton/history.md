# Keaton — Lead — History

## Core Context

DevDocket is a VS Code extension for managing work items. Phase 1 is complete:
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

### 2025-01-09 — Issue #342: Command Registration Architecture Analysis

**Status:** COMPLETE — Analysis posted to GitHub, decision documented

Triaged vague issue #342 ("Factor out command registration across extensions") to understand if commands were misconfigured across packages.

#### Findings

✅ **Architecture is correct.** All 43 VS Code commands are properly in core (`packages/core/src/commands/`):
- Core owns all commands because they operate on core's work item state, views, and lifecycle
- Providers (GitHub, ADO) correctly register only via `api.registerProvider()` — discovery is API-driven, not command-driven
- Actions (Start Git Work, AI Reviewer) correctly register only via `api.registerAction()` — invoked programmatically
- AI Reviewer uses chat participants and LM tools, not commands

#### Command Inventory

| View/Concern | Count | Modules |
|--------------|-------|---------|
| Inbox operations | 3 | inboxCommands.ts |
| Queue operations | 2 | queueCommands.ts |
| Focus operations | 5 | focusCommands.ts |
| History operations | 1 | historyCommands.ts |
| Layout toggles | 17 | layoutCommands.ts (per-view layout switches) |
| Watch management | 6 | watchCommands.ts |
| Item creation | 5 | generalCommands.ts |
| General | 4 | generalCommands.ts |

All commands wired in `packages/core/src/commands/commands.ts` → registered in `extension.ts`.

#### API Surface Impact

✅ **No changes needed.** DevDocketApi doesn't expose command registration (correct—commands are internal). If providers ever need commands, could extend API at that time (not needed today).

#### Recommendations (Non-Breaking)

- **Phase 1 (Clarity):** Add `README.md` to `packages/core/src/commands/` documenting command ownership
- **Phase 2 (Optional):** Create command registry interface for machine-readable ownership + automated tests
- **Phase 3 (If Needed):** Extend DevDocketApi if providers ever need commands (unlikely)

#### Decision

Issue disposition: Close as **working-as-intended** or **type:enhancement** (if pursuing Phase 1 docs).

Records:
- Decision: `.squad/decisions/inbox/keaton-command-registration.md`
- Analysis: `command-registration-analysis.md` (in root, can be deleted after merging notes to issue)

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
- Key files reviewed: `types.ts`, `providerRegistry.ts`, `workItem.ts`, `inboxTreeProvider.ts`, `focusTreeProvider.ts`, `extension.ts`, `package.json`, `workGraph.ts`, `commands.ts`, `devDocketApi.ts`, `githubProvider.ts`

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

## Triage Round 1 — 18 Squad Issues (2026-07-23)

**Status:** COMPLETE — All 18 issues routed and triage comments posted.

### Routing Summary

| Route | Count | Issues |
|-------|-------|--------|
| squad:fenster | 17 | 255, 254, 253, 252, 250, 249, 243, 240, 233, 232, 228, 226, 225, 219, 218, 217, 215 |
| squad:keaton | 1 | 234 |

### Key Decisions

1. **Issue #234 (Done vs Archived)** — Routed to Keaton for architecture/UX decision. This requires clarifying state machine semantics (auto-archive? explicit? time-based?) before Fenster can implement. Will need a design decision in `.squad/decisions.md` before work begins.

2. **Issue #253 & #254 (AI Actions)** — Both routed to Fenster. #253 (shared repo) is Large complexity and may unlock #254 (model selection). Fenster should evaluate sequencing.

3. **Issue #225 (Onboarding)** — Marked Large complexity. This is a significant UX feature that might benefit from user research or early prototyping before full implementation.

4. **Dependencies flagged:**
   - #254, #253, #240 form a cluster around AI actions and URL handling
   - #249 (Inbox→Focus shortcut) is independent but related to state machine changes
   - #243 (re-requested reviews) requires new provider-level signals

### Triage Process Notes

- All 18 issues read via `gh issue view` and analyzed for scope/routing
- Comments include: assignment, complexity (small/medium/large), category, dependencies, implementation notes
- All comments posted safely with `--body-file` to avoid PowerShell backtick escaping issues

## Triage Round 2 — 12 Squad Issues (2026-07-24)

**Status:** COMPLETE — All 12 issues routed and triage comments posted.

### Routing Summary

## Squad Triage & Routing (2026-04-20)

### Triage Round — 12 Untriaged Squad Issues

**Status:** COMPLETE — Keaton triaged all 12 untriaged issues via background agent.

**Routed to Fenster:** 8 issues
- **Bugs:** #298, #299, #300
- **Chores:** #301, #302, #303, #305, #306
- **Rationale:** Fenster owns provider implementations and provider API surface; bugs/chores align with existing focus areas

**Deferred to Keaton:** 4 issues
- **Architecture/Scope Decisions:** #292, #304, #307, #308
- **Rationale:** Require lead judgment on scope, priority trade-offs, or architectural direction. Pending design review.

See `.squad/orchestration-log/2026-04-20T16-18-00Z-keaton.md` for full triage details.

| Route | Count | Issues |
|-------|-------|--------|
| squad:fenster | 7 | 298, 299, 300, 301, 302, 303, 305, 306 |
| squad:keaton | 5 | 304, 307, 308, 292 |

### Key Decisions

1. **Bugs (High Priority - Fenster):**
   - #298 (fetch/git timeouts): Medium complexity. Blocks extension activation on slow networks.
   - #299 (double disposal): Small complexity. Remove manual deactivate() calls, rely on context.subscriptions idiom.
   - #300 (CancellationToken wiring): Medium complexity. Wire token to AbortSignal in providers. Coordinate with #298.

2. **Enhancement (Fenster):**
   - #301 (provider health visibility): Medium complexity. Recommend status bar item for unhealthy provider discovery.

3. **Chores (Fenster):**
   - #302 (consolidated types): Large complexity. Create @devdocket/types or expand @devdocket/shared. ai-reviewer's copy is already stale.
   - #303 (BaseGitHubProvider extends BaseProvider): Large complexity. Eliminates duplication, matches ADO pattern. Benefits from completing #298/#300 first.
   - #305 (split monolith commands.ts): Medium complexity. Pure refactoring — no behavior change.
   - #306 (WorkItemEditorPanel cache lifecycle): Small complexity. Move static Map to instance-level manager.

4. **Architecture Decisions (Keaton):**
   - #304 (JSON stores → globalState): Large complexity, LOW priority. Architectural decision required before Fenster implements. Trade-offs: raw JSON (debugging) vs. globalState (platform ownership). Defer decision until storage pain is felt.
   - #307 (weekly codebase review): Medium complexity, LOW priority. Meta-task (workflow setup). Scope decision: implement now or defer? Recommend defer until MVP stabilizes.
   - #308 (weekly UX review): Medium complexity, LOW priority. Companion to #307. Scope decision: defer until post-MVP usability focus.
   - #292 (automated code refactoring): Medium complexity, LOW priority. Should automated refactoring PRs be submitted without review? Keaton decision on scope and timing.

### Complexity Summary

- Small: #299, #306 (2 issues)
- Medium: #298, #300, #301, #305, #304, #307, #308, #292 (8 issues)
- Large: #302, #303 (2 issues)

### Priority & Sequencing Recommendations

**Immediate (Bugs):**
1. #299 (small, quick win, lifecycle correctness)
2. #298 + #300 (coordinate fetch timeout + CancellationToken wiring)

**Next Sprint (Enhancements & Smaller Chores):**
3. #301 (medium, improves UX for provider failures)
4. #305 (medium, improves code organization)
5. #306 (small, improves lifecycle safety)

**Post-MVP or Parallel Track (Large Refactorings):**
6. #302 (large, consolidates types, enables #303)
7. #303 (large, eliminates duplication, requires #302 first)

**Deferred (Architecture Decisions & Process Setup):**
8. #304 (decide architecture, then implement)
9. #307, #308, #292 (Keaton scopes timing and priorities)

### Triage Process Notes

- All 12 issues read via `gh issue view --json body,comments`
- Comments include: assignment, complexity, category, dependencies, and implementation guidance
- All comments posted safely with `--body-file` to avoid shell escaping issues
- Fenster has 8 routable issues; Keaton has 5 scoping/decision issues

## Issue #304: JSON Stores → globalState Migration Analysis (2026-04-20)

**Status:** COMPLETE — Analysis posted to GitHub, recommendation finalized

### Findings Summary

Conducted full architectural analysis on migrating four JSON file stores (JsonTaskStore, DiscoveredStateStore, ReadStateStore, ProviderLabelCache) to VS Code's globalState API.

#### Infrastructure Audit

- **SerializedJsonStore base class:** 99 lines (write queue serialization, file I/O, corruption recovery)
- **Per-store overhead:** ~70 lines duplicated (validation, caching, load deduplication)
- **Total duplication:** ~170 lines of persistence infrastructure across four stores

| Store | Lines | Complexity | Business Logic |
|-------|-------|-----------|-----------------|
| JsonTaskStore | 242 | High | WorkItem validation, activity log, rollback |
| DiscoveredStateStore | 259 | Low | Thin records, multi-version tracking |
| ReadStateStore | 145 | Low | Set operations, lazy loading |
| ProviderLabelCache | 86 | Very Low | Key-value cache, fallback-safe |

#### globalState Capability Assessment

✅ **Handles DevDocket's scale:**
- Typical data volume: ~136 KB (WorkItems + DiscoveredState + ReadState)
- Platform provides: atomicity, concurrent access handling, corruption recovery
- Type support: JSON-serializable only (no binary data)

⚠️ **Trade-offs:**
- Loses file access (debugging/export harder)
- No built-in validation (application-level required)
- No TTL/expiry mechanism (cache invalidation at app level)
- Scope unclear in docs (global vs. workspace)

#### Migration Feasibility by Store

| Store | Migrate? | Rationale |
|-------|----------|-----------|
| DiscoveredStateStore | ✅ Yes | Thin cache, high read volume, perfect fit for globalState |
| ReadStateStore | ✅ Yes | Stateless, infrequent writes, no complex logic |
| JsonTaskStore | ⚠️ No | Export/debugging critical, complex validation, activity log |
| ProviderLabelCache | ⚠️ No | Informational cache, value in transparent file access |

#### Testing Impact

- Thin stores (DiscoveredStateStore, ReadStateStore): straightforward globalState mock in vscode.ts
- No regression expected; test patterns same (just different I/O backend)
- Effort: 1–2 days for mock + test updates
- Simplifies tests: globalState mocks simpler than file I/O; no tmpdir cleanup

### Recommendation: Option C — Hybrid Approach

**Phase 1 (1–2 weeks): Migrate thin caches**
1. Add globalState mock to vscode.ts
2. Refactor DiscoveredStateStore, ReadStateStore
3. Update tests
4. Migrate existing data on startup (with rollback)

**Phase 2 (Post-MVP): Defer JsonTaskStore**
- Keep JsonTaskStore and ProviderLabelCache as JSON files
- Revisit only if file I/O pain reported
- Maintains debuggability and export capability

### Benefits

1. **Reduced code:** Remove 99-line SerializedJsonStore + 60+ lines per-store duplication
2. **Simplified testing:** globalState mocks eliminate tmpdir dependency
3. **Maintained transparency:** WorkItems and labels remain as plain JSON
4. **Platform leverage:** Use VS Code's native SQLite for cache data
5. **Low risk:** Thin stores first, critical data unchanged

### Records

- **Decision:** `.squad/decisions/inbox/keaton-globalstate-migration.md` (full 14 KB analysis)
- **GitHub comment:** Posted to issue #304 with summary and implementation roadmap
- **Risk assessment:** Included migration path for existing data with rollback strategy

