# Squad Decisions

## Active Decisions

### ADO State-Category-Based Filtering (2025-01-22)

**Author:** Fenster (Extension Dev)  
**Status:** Implemented

Azure DevOps work item states vary by process template (Agile, Scrum, CMMI, custom). Previously, the ADO provider hardcoded state exclusions in the WIQL query, which was fragile across different templates.

**Decision:** Implement two-layer filtering using ADO's **Work Item Type States API** to dynamically determine terminal states based on their **category**:

1. **Layer 1 (WIQL):** Exclude common terminal states (`Closed`, `Removed` only) for performance, preventing thousands of old work items from being fetched.

2. **Layer 2 (State Category API):** After fetching work item details, call the states API for each unique `(project, workItemType)` pair and filter out items where `System.State` is in a terminal category (`Completed`, `Removed`, `Resolved`).

**Implementation Details:**
- Cache key: `{project}/{workItemType}` — survives multiple refresh cycles
- Terminal categories: `Completed`, `Removed`, `Resolved`
- Fail-open pattern: If states API fails, return empty set (no filtering applied for that type)
- URL-encoding: Applied to org, project, and workItemType for API safety

**Rationale:**
- Works across all process templates without hardcoding state names
- WIQL filtering reduces initial data volume; states API provides correctness
- Fail-open ensures extension remains usable if metadata is unavailable
- Caching prevents redundant API calls for same work item type within refresh cycle

**Test Coverage:** 9 new tests + 16 pre-existing test fixes  
**Result:** All 132 ADO tests pass, 1124 total tests pass

**References:**
- Issue #178
- `packages/ado/src/adoWorkItemProvider.ts`
- ADO REST API: [Work Item Type States](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-type-states/list)

---

### Four-View Model Architecture (2026-03-24)

**Leads:** Matt Thalman (via Copilot), Keaton (review)  
**Status:** Implemented

The extension now uses a four-view model: **Inbox** (unseen discovered items) → **Queue** (accepted new WorkItems) → **Focus** (in-progress items) → **Sources** (all discovered items grouped by provider/group).

**Key Design:**
1. **InboxState enum:** `'unseen' | 'accepted' | 'dismissed'` persisted as `discovered-state.json`
2. **No persisted item data:** Title/description/url/group read live from provider; only state index persisted
3. **Migration path:** Existing WorkItems with `providerId`+`externalId` seed state as `'accepted'` on first activation
4. **Dismissed items are sticky:** Providers cannot re-surface dismissed items in Inbox
5. **Accepted WorkItems persist:** Even if provider drops the external item
6. **View separation:**
   - `InboxTreeProvider` shows unseen DiscoveredItems
   - `QueueTreeProvider` (renamed from old InboxTreeProvider) shows WorkItems in New state
   - `FocusTreeProvider` unchanged
   - `SourcesTreeProvider` (NEW) shows hierarchical Provider → Group → Item tree

**Rationale:** Decouples provider discovery from WorkItem creation, giving users explicit control over what enters their queue via accept/dismiss actions.

**Implementation:** 10 steps completed (Fenster) + 57 tests (Hockney). All 121 tests passing.

**References:**
- `coordinator-four-view-design-2026-03-24T03-15-59Z.md` — overall vision
- `keaton-four-view-review.md` — architectural review and refinements
- `fenster-inbox-sources-architecture.md` — implementation details

---

### GitHub Package vscode Mock (2026-01-24)

**Author:** Fenster (Extension Dev)  
**Status:** Implemented

Created `packages/github/src/test/__mocks__/vscode.ts` extending the core mock with:
- `authentication.getSession` — returns `{ accessToken: 'mock-token' }`
- `workspace.getConfiguration` — returns `.get(key, default)` stub
- `workspace.workspaceFolders` — workspace folder detection
- `extensions.getExtension` — core extension dependency lookup
- `commands.executeCommand` — covers `vscode.openFolder`
- `Uri.file` — worktree URI creation
- `window.showErrorMessage` — error dialogs

**Rationale:** Each package owns its own test infrastructure to avoid coupling. Explicit mocking required since vscode is external.

---

### Code Review Fix Patterns (2026-03-24)

**Author:** Fenster (Extension Dev)  
**Context:** PR #1 code review by Keaton identified 7 Critical + 8 Important issues  
**Status:** Applied

Five key patterns established to prevent similar issues in future PRs:

1. **In-Memory Cache for Storage Layer** — JsonTaskStore maintains `Map<string, WorkItem>` as source of truth to eliminate read-modify-write races where concurrent saves could overwrite each other. Cache checked before disk reads; disk is purely for persistence.

2. **Git Operation Safety** — Always check preconditions before destructive git operations (branch existence with `git branch --list`, directory existence with `fs.existsSync`). Implement rollback for multi-step operations (delete branch if worktree creation fails).

3. **Stable External IDs** — Use `owner/repo#number` format instead of `html_url` to survive issue transfers between repositories. Requires parsing from url but provides reliable long-term identity.

4. **User-Facing Error Accumulation** — Accumulate failures across multiple operations and show a single user notification (e.g., "Failed to fetch from 3 repositories") instead of console-only logging.

5. **Immutable Updates** — Clone items before patching in `updateItem()` using `{ ...item, ...patch }` to prevent inconsistent state if `store.save()` fails.

**Implementation:** All 15 review issues (C1-C7, I1-I8) fixed by Fenster + 32 Copilot review comments addressed across 4 review rounds.

**Test Coverage:** Hockney updated 7 tests and added 3 new cases to match production changes. Final suite: 124 tests passing.

**References:**
- `keaton-pr1-review.md` — detailed review findings
- `fenster-pr1-fixes.md` — implementation details
- `hockney-pr1-tests.md` — test update patterns

---

### Test Update Patterns (2026-03-25)

**Author:** Hockney (Tester)  
**Context:** 7 tests failed after Fenster's code review fixes  
**Status:** Applied

Four key test patterns identified during fix verification:

1. **Async Event Handler Testing** — Use `vi.waitFor()` when testing async event handlers, even if events fire synchronously. Prevents test timing assumptions from coupling to implementation.

2. **OS-Specific Path Separators** — Windows path.join produces backslashes; test assertions must match OS-specific paths. Use `\\` in test assertions on Windows rather than `/`.

3. **Mock fs for Filesystem Checks** — Use `vi.mock('fs')` with stubbed `existsSync` when testing filesystem precondition checks (e.g., before creating worktree directories).

4. **Git Operation Sequencing** — Test the full operation sequence including guards (precondition checks) and rollback logic, not just happy path. Updated call counts reflect guard checks.

**Test Improvements:** 
- Fixed 7 failing tests after production changes
- Added 3 new test cases for branch/directory existence checks and rollback
- Expanded GitHub package tests from 23 to 26

**Test Suite Metrics:** 121 tests pre-fix → 124 tests post-fix, all passing (98 core + 26 GitHub).

**References:**
- `hockney-pr1-tests.md` — detailed test update walkthrough
- Test files: `providerRegistry.test.ts`, `githubProvider.test.ts`, `startWorkAction.test.ts`

---

### Phase 2 Test Strategy (2026-07-17)

**Author:** Hockney (Tester)  
**Status:** Applied

Four core decisions:
1. **Mock helpers per test file** — each test self-contained, avoids cross-file coupling
2. **`vi.stubGlobal('fetch')`** — simpler than vi.mock for GitHubIssueProvider
3. **Callback-style `execFile` mock** — matches production code's `promisify(execFile)` pattern
4. **`vi.waitFor()` for async settling** — avoids coupling tests to implementation timing

Added 42 tests in Phase 2 (providerRegistry, actionRegistry, githubProvider, startWorkAction). Extended with 57 tests in four-view phase (discoveredStateStore, inboxTreeProvider, sourcesTreeProvider, migration, providerRegistry extensions).

---

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
