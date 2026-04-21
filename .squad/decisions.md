# Squad Decisions

## Active Decisions

### 2026-04-21T07:05:30Z: Issue #342 — Command Registration Architecture Review

**Issue:** #342  
**Author:** Keaton (Architecture)  
**Status:** COMPLETE — Findings posted to issue  
**Date:** 2026-04-21

#### Problem Statement

Issue #342 questioned whether command registration was misconfigured and whether providers (GitHub, ADO) should own their own commands.

#### Key Finding

Current architecture is **correct**. All 43 commands belong in core (`packages/core/src/commands/`):
1. All commands operate on core's work item state model (WorkItem, WorkItemState)
2. All commands interact with core views (Inbox, Queue, Focus, History, Sources, Watches)
3. Provider items are ephemeral (read live); only core maintains persistent state
4. Layout/view management commands are inherently core concerns

Providers are discovery agents (no UI operations). Actions are programmatic (invoked via `devdocket.runAction`). Neither needs command registration.

#### API Review

DevDocketApi correctly does NOT expose command registration — commands are internal implementation details, not API contracts.

#### Recommendation

Close #342 as `status:working-as-intended`. Optional enhancement: add `packages/core/src/commands/README.md` documenting command organization and how to add new commands.

---

### 2026-04-21T07:05:30Z: Issue #304 — JSON File Stores vs. VS Code globalState Migration

**Issue:** #304  
**Author:** Keaton (Architecture)  
**Status:** RECOMMENDATION PENDING  
**Date:** 2026-04-21

#### Problem Statement

DevDocket persists four datasets (work items, discovered state, read state, provider label cache) as separate JSON files, each implementing shared infrastructure: write serialization, corruption recovery, validation. Should we migrate to VS Code's globalState API?

#### Recommendation: Option C — Hybrid Approach (Phased Migration)

**Migrate to globalState:**
- DiscoveredStateStore (thin, read-heavy inbox state cache)
- ReadStateStore (simple set of read/unread keys)

**Keep as JSON files:**
- JsonTaskStore (complex WorkItem structure, critical for debugging/export)
- ProviderLabelCache (informational, small, simple)

#### Rationale

1. **Simplify infrastructure:** Remove 99-line SerializedJsonStore base + 170 lines of duplicated persistence code
2. **Maintain debuggability:** Keep JSON export for WorkItems (critical) and ProviderLabelCache (informational)
3. **Leverage platform:** Use globalState for cache-like data where atomicity is automatic
4. **Gradual, low-risk:** Migrate two small stores first; keep critical JsonTaskStore untouched
5. **Reduce test complexity:** globalState mocks simpler than file I/O mocking

#### Phase 1: Migrate Thin Caches (Week 1–2)

Tasks:
1. Add globalState mock to vscode.ts (1 day)
2. Refactor DiscoveredStateStore to use globalState (1 day)
3. Refactor ReadStateStore to use globalState (0.5 days)
4. Update tests (1.5 days)
5. Validation & documentation (0.5 days)

#### Non-Recommendations

- **Option A (Keep All JSON):** Duplicates infrastructure, requires manual recovery
- **Option B (Migrate All):** Loses debuggability, validation becomes app-level, loses export capability

#### Success Metrics

1. Reduced code: Remove 99-line base class and 60+ lines per-store infrastructure
2. Maintained test coverage: No drop in test count or quality
3. No user-visible changes: DiscoveredState and ReadState behavior identical
4. Faster tests: globalState mocks simpler than file I/O
5. Easier debugging: globalState stores visible in VS Code storage location

#### Next Steps

1. Code review: Present decision to team; collect feedback on globalState scope
2. Validate globalState scope: Confirm multi-workspace behavior
3. Phase 1 implementation: Assign to backend engineer + test engineer
4. Documentation: Update storage.instructions.md with globalState patterns

---

### 2026-04-23T00:00:00Z: Issue #225 — Onboarding Walkthrough Implementation

**Issue:** #225  
**Author:** Fenster (Extension Dev)  
**Status:** Implemented  
**Date:** 2026-04-23

## Context

Implemented VS Code walkthrough for new user onboarding to guide users through creating their first work item, understanding the Inbox → Queue → Focus → History workflow, connecting providers, and managing active work.

## Key Decisions

#### 1. VS Code Native Walkthrough API
**Decision:** Use `contributes.walkthroughs` in package.json rather than a custom modal or webview.  
**Why:** VS Code's native walkthrough API provides a consistent UX familiar to users from other extensions. Appears in the Get Started tab automatically. No custom UI code needed.

#### 2. Four-Step Onboarding Flow
**Decision:** Four steps — Create First Item, Understand Workflow, Connect Provider, Focus on Work.  
**Why:** Mirrors the natural user journey. Start with immediate action (create item), then explain concepts, then expand with providers, then close the loop with completion workflow.

#### 3. Markdown Media Files
**Decision:** Each step uses a markdown file in `media/walkthroughs/` directory with command links.  
**Why:** Markdown allows rich formatting, code blocks, headers, and interactive command links (e.g., `[Create Work Item](command:devdocket.createItem)`). Easier to maintain than inline JSON strings.

#### 4. Command Links for Interactivity
**Decision:** Embed command links in both step descriptions and markdown media.  
**Why:** Users can click directly to perform actions (create item, open extensions view, etc.) without searching for commands. Makes onboarding interactive rather than passive reading.

#### 5. Media Organization
**Decision:** Created dedicated `packages/core/media/walkthroughs/` directory.  
**Why:** Keeps walkthrough content separate from other media assets. Future walkthroughs can add more files here. Mirrors pattern used by other VS Code extensions.

## Files Changed

- `packages/core/package.json` — Added `walkthroughs` contribution
- `packages/core/media/walkthroughs/create-item.md` — Step 1 content
- `packages/core/media/walkthroughs/workflow.md` — Step 2 content
- `packages/core/media/walkthroughs/providers.md` — Step 3 content
- `packages/core/media/walkthroughs/focus.md` — Step 4 content

## Future Considerations

- Add screenshots or animated GIFs to media files for visual learners
- Consider per-provider walkthroughs for GitHub/ADO setup
- Track walkthrough completion via telemetry (if added in the future)

---

### 2026-04-20T02:07:15Z: Issue #266 — CI Pipeline Watching Feature

**Issue:** #266  
**Author:** Fenster (Extension Dev)  
**Status:** Implemented  
**Date:** 2026-04-20  

## Context

Implemented fire-and-forget pipeline watching for GitHub Actions and Azure DevOps Pipelines — polls for run status updates and notifies on completion/failure without blocking user workflow.

## Key Decisions

#### 1. Hybrid Architecture Pattern
**Decision:** Core owns the `WatcherService` lifecycle, providers supply `DevDocketRunWatcher` interface.  
**Why:** Mirrors existing provider/action plugin patterns. Keeps polling logic centralized while provider-specific API calls are delegated. Both GitHub Actions and ADO Pipelines implemented using this pattern.

#### 2. Persisted Watch Lifecycle
**Decision:** Watches are persisted to `watches.json` via `WatchStore` and restored on activation, surviving VS Code restarts. Dismissed watches are excluded on restore.  
**Why:** Users shouldn't lose active watches if VS Code restarts while a pipeline is still running. Write-queue serialization prevents file corruption. Completed/dismissed watches are cleaned up on restore.

#### 3. API Surface Extension
**Decision:** Added optional `registerRunWatcher(watcher: DevDocketRunWatcher)` to `DevDocketApi`.  
**Why:** Non-breaking additive API change. GitHub extension checks `typeof api.registerRunWatcher === 'function'` for graceful degradation with older core versions.

#### 4. Early Failure Notifications
**Decision:** Notify immediately when a job fails while run is still in progress (with running job count).  
**Why:** Design spec requirement. Configurable via `devdocket.watches.notifyOnJobFailure` (default: true) so users can opt out if too noisy.

#### 5. vscode Mock Expansion
**Decision:** Added `StatusBarAlignment` enum and `createStatusBarItem()` to `packages/core/src/test/__mocks__/vscode.ts`.  
**Why:** `WatchesStatusBar` uses `vscode.StatusBarAlignment.Right`. Mock needed to support testing without real VS Code.

#### 6. Concurrency Guard Pattern
**Decision:** `WatcherService.pollAllWatches()` uses `isPollInFlight` flag to skip ticks if previous poll still running.  
**Why:** Follows `BaseProvider` pattern. Prevents overlapping polls from queuing up if API calls are slow.

#### 7. 3-Strike Failure Handling
**Decision:** After 3 consecutive poll failures, set `hasWarning: true` and skip that run in subsequent poll ticks.  
**Why:** Surfaces likely permanent failures (auth expired, run deleted) without removing the watch. Run stays in tree with warning icon. User can dismiss and re-watch.

## Future Considerations

- **Auto-watch on push:** Design spec "Out of Scope (Future)" item. Could auto-detect workflow triggers from branch push events.
- **Webhook-based updates:** Design spec future item. Would replace polling with push notifications when supported.

---

### 2026-04-20T02:07:15Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** Whenever possible, use the item activity log to derive data rather than storing new metadata on WorkItem. The activity log should be the source of truth for historical data (e.g., branch/worktree associations, state change history, action records). Only add new fields to WorkItem when the data truly cannot be derived from the log.

**Why:** User request — captured for team memory

---

### 2026-04-19T23:22:32Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** The core extension must not rely on anything from the other extensions (github, ado, start-git-work, ai-reviewer) beyond the contract defined in the API types. Core orchestrates, providers supply data — no direct imports or coupling beyond the published interfaces.

**Why:** User request — captured for team memory

---

### 2026-04-19T19:45:31Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** When requesting Copilot PR review, always follow the instructions in the copilot-pr-review skill rather than ad-hoc review requests. Invoke the skill for the full feedback loop.

**Why:** User request — captured for team memory

---

### 2026-04-19T19:41:35Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** When reading a GitHub issue to implement a fix, always read the issue description AND all posted comments — not just the issue body. Comments often contain design decisions, clarifications, and updated requirements.

**Why:** User request — captured for team memory

---

### 2026-04-17T20:48:27Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** After ANY code change is pushed to a PR branch — whether from code review fixes, CI failure fixes, user feedback, or any other reason — the agent MUST immediately re-request Copilot review and run the full copilot-pr-review feedback loop. This is never optional and should never require the user to remind.

**Why:** User request — captured for team memory

---

### 2026-04-17T18:00:02Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** The coordinator must not do deep codebase exploration, multi-file reading, or detailed implementation planning itself. Fetch the issue description (via `gh issue view`), then immediately dispatch to the assigned agent with the issue context. The agent owns exploration, planning, and implementation. The coordinator's job is routing and supervision, not engineering.

**Why:** User request — captured for team memory

---

### 2026-04-17T12:20:36Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** Always use git worktrees for parallel issue work. When Ralph spawns multiple agents to work on separate issues simultaneously, each agent should work in its own worktree for full isolation.

**Why:** User request — captured for team memory

---

### 2026-04-15T20:02:05Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** Never include the branch name in the PR title. PR titles should be descriptive of the change, not reference branch names, issue numbers, or other metadata.

**Why:** User request — captured for team memory

---

### 2026-04-15T20:01:13Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** Never include the issue number in the PR title. Issue numbers belong in the PR description only (via Closes #N).

**Why:** User request — captured for team memory

---

### 2026-04-15T19:58:00Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** Never include the issue number in a commit message. Issue references belong in the PR description only.

**Why:** User request — captured for team memory

---

### 2026-04-15T19:57:47Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** All PRs should reference in their description the issue they're fixing.

**Why:** User request — captured for team memory

---

### 2026-04-15T19:26:30Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** Each phase of the create-pr lifecycle between agents should be independent. Start remote review cycles while other agents are still doing local loops. No serialization between agents.

**Why:** User request — captured for team memory

---

### 2026-04-15T19:13:21Z: User directive

**By:** Matt Thalman (via Copilot)

**What:** When Ralph is finished implementing a fix, he should run the create-pr skill (exactly, to the letter). The review loop mentioned in that skill needs to be done in an agent in parallel with other tasks.

**Why:** User request — captured for team memory

---

## Technical Decisions

### 2026-04-18 — Activity-Log-Based Cleanup Tracking

**Issue:** #264  
**Author:** Fenster (Extension Dev)  
**Status:** Implemented

#### Context

Issue #264 required tracking git branch and worktree metadata created by the Start Git Work action so we can prompt for cleanup when items are completed.

#### Decision

Use the work item's activity log as the source of truth for branch/worktree associations instead of adding metadata fields to the WorkItem model.

##### Implementation

1. **Activity types:** Added `'work-started'`, `'cleanup'`, and `'cleanup-dismissed'` to `ActivityType`.
2. **Logging work info:** StartWorkAction calls `devdocket.addActivity` with type `'work-started'` and a JSON detail string containing `{ branchName, worktreePath, repoPath }`.
3. **Reading work info:** `gitCleanup.ts` finds the most recent `'work-started'` entry in the activity log and parses its JSON detail to extract branch/worktree/repo info.
4. **Dismissal tracking:** When the user clicks "No" on the cleanup prompt, a `'cleanup-dismissed'` entry is logged. The cleanup check skips prompting if a `'cleanup-dismissed'` entry exists after the last `'work-started'` entry.
5. **Cleanup logging:** Successful cleanup logs a `'cleanup'` entry with a human-readable detail (e.g., "Removed worktree and branch feature/x").
6. **Command:** `devdocket.addActivity` registered for extensions to log activities. Validates type against known values.

#### Rationale

- **Activity log as source of truth:** Avoids adding action-specific metadata fields to the WorkItem model. The activity log already exists and is designed for tracking significant events.
- **JSON detail string:** Structured data lives in the `detail` field of the `'work-started'` entry. Machine-readable while staying within the existing `ActivityLogEntry` shape.
- **Dismissal via activity entry:** Avoids a `cleanupDismissed` boolean on WorkItem. The temporal ordering of log entries naturally handles "re-arm after new work-started" — a new `'work-started'` entry after a `'cleanup-dismissed'` entry will trigger a fresh prompt.
- **Non-blocking cleanup prompt:** Transition succeeds immediately. Prompt fires asynchronously.
- **Safety-first git operations:** `git branch -d` (not `-D`) warns about unmerged changes. `--` terminators on all commands. `git show-ref --verify` for exact branch checks.

#### Consequences

- **Pro:** No additional fields on WorkItem — cleaner model.
- **Pro:** Activity log provides a full audit trail of work-started/cleanup/dismissed events.
- **Pro:** Re-arming after new work-started is automatic — no need to manually reset flags.
- **Con:** Detail field is JSON, which is less human-readable than plain text for `'work-started'` entries.
- **Breaking:** Three new `ActivityType` values. Extensions with exhaustive switch must add cases.

#### Alternatives Considered

1. **WorkItem metadata fields:** Original approach (PR #321 v1). Worked but added action-specific fields to the core model.
2. **Store metadata in action's globalState:** Doesn't survive if action extension is uninstalled. Metadata is logically part of the work item lifecycle.
3. **Infer repo path from worktree path:** Fragile, couples cleanup to naming convention.

---

### Issue #243 — Version-Based Resurfacing for Re-Requested PR Reviews (2026-04-15)

**Issue:** #243  
**Author:** Fenster (Extension Dev)  
**Status:** Implemented

## Problem

When a PR review is re-requested after the user has completed their review (Done/Archived), the same `externalId` is already in the state store as `accepted`. The item never reappears in the Inbox.

## Decision

Added an optional `version` field to `DiscoveredItem` that providers set to a value that changes when the item needs re-attention. When `handleDiscoveredItems()` processes an `accepted` item whose stored version differs from the incoming version, it resets the state to `unseen`.

### Version sources by provider

- **GitHub PR Reviews:** `updated_at` from the Search API — changes when the PR is updated (including review re-requests)
- **ADO PR Reviews:** `lastMergeSourceCommit.commitId` — changes when the PR author pushes new commits (the typical trigger for re-review)

### Key design choices

1. **Optional field (non-breaking):** `version` is optional on `DiscoveredItem`, so existing providers are unaffected.
2. **Backfill without resurfacing:** When a pre-existing accepted item first receives a version (no stored version yet), the version is silently stored without changing state. This prevents a flood of resurfaced items on initial deployment.
3. **Dismissed items stay dismissed:** Version changes on dismissed items are ignored, preserving the fix from #189.
4. **Unseen items unchanged:** If an item is already unseen, version changes don't trigger any action.

### What was NOT implemented

- **Dismissed-item resurfacing:** Deliberately excluded — dismissed means "not interested," regardless of version changes.
- **Separate version-only update method:** Backfills are batched into the same `setStates` call with the existing state, avoiding additional API surface.

## References

- Branch: `squad/243-pr-review-resurface`
- `packages/shared/src/baseProvider.ts` — `DiscoveredItem.version`
- `packages/core/src/services/providerRegistry.ts` — `handleDiscoveredItems()` version logic
- `packages/core/src/storage/discoveredStateStore.ts` — `getVersion()`, version persistence
- Issue #189 — dismissed items fix (preserved)

---

### Issue #233 — Provider Health Indicator Design (2026-04-15)

**Issue:** #233  
**Author:** Fenster (Extension Dev)  
**Status:** Implemented

## Context

When a provider's background refresh fails (network timeout, auth failure, rate limit), the UI showed no indication. Items from the last successful refresh remained displayed, giving a false sense of currency.

## Decision

Track provider health in `ProviderRegistry` and surface it visually in Sources and Inbox tree views.

### Health tracking

- `ProviderHealthStatus` interface with `status` ('healthy' | 'unhealthy' | 'unknown'), `lastRefreshTime`, and `lastError`
- Health updated inside `refreshWithTimeout`: success → healthy, error → unhealthy with message, timeout → unhealthy with "Refresh timed out"
- `onDidChangeProviderHealth` event drives UI reactivity
- Health data is cleaned up on provider unregister

### Visual indicators

- **Warning icon:** Provider nodes show `warning` ThemeIcon (yellow, via `problemsWarningIcon.foreground`) when unhealthy
- **Description:** Provider nodes show "refresh failed" text when unhealthy
- **Tooltip:** Provider nodes always show a tooltip with provider name, last successful refresh time (relative), and error details when unhealthy
- **Unhealthy providers with 0 items:** Still shown in Sources tree so the warning is visible

### What was NOT implemented

- **Status bar item:** Considered but deferred — the tree view indicators are sufficient and don't clutter the status bar for users who don't use providers
- **Auto-retry with backoff:** Out of scope — providers already handle their own periodic refresh via `BaseProvider.startPeriodicRefresh`
- **Persisting health state:** Health is transient (in-memory only) since it reflects the current session's connectivity

## References

- Branch: `squad/233-provider-health`
- `packages/core/src/services/providerRegistry.ts` — `ProviderHealthStatus`, health tracking
- `packages/core/src/views/sourcesTreeProvider.ts` — warning icon + tooltip
- `packages/core/src/views/inboxTreeProvider.ts` — warning icon + tooltip
- `packages/core/src/utils/time.ts` — `formatRelativeTime` utility

---

### Issue #240 — URL-Imported Items Use Synthetic Provider ID (2026-04-15)

**Issue:** #240  
**Author:** Fenster (Extension Dev)  
**Status:** Implemented

## Context

The "Create Item from URL" command creates work items from GitHub/ADO PR URLs. These items need a `providerId` and `externalId` for provenance tracking, but they don't come from a registered provider extension.

## Decision

Use `providerId: 'url-import'` and `externalId: <canonical URL>` for URL-imported items.

## Rationale

- Using the canonical URL as `externalId` is unique and stable — it won't collide with provider-assigned external IDs (which use `owner/repo#number` format)
- A synthetic `providerId` clearly distinguishes manually imported items from provider-discovered ones
- This avoids coupling the core extension to provider-specific ID formats
- If a provider later discovers the same PR, the different `externalId` format means no collision — both can coexist (the user may want to track it independently)

## Alternatives Considered

1. **No providerId/externalId:** Would work but loses the ability to detect duplicates or link back to the source
2. **Match provider ID format:** Would require the core to know about GitHub/ADO provider ID formats, creating tight coupling
3. **Use `providerId: 'github'`/`'ado'`:** Would conflict with the actual provider extensions' namespace

## Trade-offs

- URL-imported items won't automatically merge with provider-discovered items for the same PR
- The `url-import` provider won't have a display label in the label cache (falls back to showing nothing)

## References

- Branch: `squad/240-create-from-url`
- `packages/core/src/commands/createItemFromUrl.ts` — URL parser, REST API fetcher, work item creation

---

### Issue #250 — Show group context in all tree view descriptions (2026-07-24)

**Issue:** #250  
**Author:** Fenster (Extension Dev)  
**Status:** Implemented

Inbox items displayed only their title without any repository/project context. Other views (Queue, Focus, History) showed provider labels but not the specific repo/project. Users working across multiple repos found items like "Fix bug #42" ambiguous.

**Decision:** Show the `DiscoveredItem.group` field (e.g., `contoso/webapp`) in tree item descriptions across all views, in both flat and tree layout modes.

- **Inbox**: `group` in tree mode; `group · provider` in flat mode
- **Queue**: `group` in tree mode; `group · provider` in flat mode
- **Focus**: `group · state` in tree mode; `group · provider · state` in flat mode
- **History**: `group · state` in tree mode; `group · provider · state` in flat mode

**Rationale:**
- The `group` field is already populated by GitHub (`org/repo`) and ADO (`org/project`) providers
- `buildDescription()` gracefully filters undefined values, so items without a group are unaffected
- Minor redundancy in tree mode is acceptable for better scanability

**References:**
- Branch: `squad/250-inbox-show-context`
- Test coverage: All 970 tests pass

---

### Issue #232 — History Cleanup via Clear Old History Command (2026-07-24)

**Issue:** #232  
**Author:** Fenster (Extension Dev)  
**Status:** Implemented

The History view grows unbounded as items are completed/archived. Heavy users accumulate hundreds of items with no way to manage them.

**Decision:** Added a "Clear Old History" command (`devdocket.clearHistory`) that removes Done and Archived items older than `devdocket.historyClearDays` (default: 30 days). The threshold is based on `updatedAt` timestamp.

**Key design choices:**
1. **Threshold uses `updatedAt`, not `createdAt`**: An item that was recently archived (even if created long ago) should be retained.
2. **No ITaskStore changes**: `clearOldHistory()` reuses `WorkGraph.deleteItem()` in a loop rather than adding batch-delete to the store interface.
3. **Modal confirmation**: Uses `vscode.window.showWarningMessage` with `{ modal: true }` to prevent accidental mass deletion.

**What was NOT implemented:**
- **Auto-pruning / max history size**: Automatic deletion risks surprising users
- **Text filter/search**: VS Code's native tree view filtering already provides text search

**References:**
- Branch: `squad/232-history-cleanup`
- `packages/core/src/services/workGraph.ts` — `clearOldHistory()` method
- `packages/core/src/commands/commands.ts` — `handleClearHistory()` handler
- `packages/core/package.json` — configuration + command + menu contributions

---

### Triage Round 1 Summary — 18 Squad Issues (2026-04-14)

**Lead:** Keaton  
**Status:** COMPLETE

Triaged all 18 open issues labeled `squad`. Routed 17 to squad:fenster (feature & bug implementation) and 1 to squad:keaton (architecture decision #234). All issues received triage comments with complexity assessment, category, and implementation notes.

**Key Routing:**
- **squad:fenster (17 issues):** Features and bugs across AI actions, UI enhancements, inbox/queue/focus flow, onboarding, and history visibility
- **squad:keaton (1 issue):** #234 — Design decision for Done vs Archived state semantics

**Complexity Breakdown:**
- Small (5): #252, #228, #219, #217, #255
- Medium (9): #254, #250, #249, #243, #240, #233, #232, #226, #218, #215
- Large (3): #253, #225

**Implementation Sequencing:** High-priority unblocked issues (#228, #219, #217, #252, #255) can start immediately. Large coordination issues (#253, #254, #240, #225, #226) require careful sequencing due to dependencies.

**References:**
- Issue #234 (Done vs Archived decision)
- `.squad/agents/keaton/history.md` — Updated with triage outcomes

---

### Issue #234 — Done vs Archived Distinction (2026-04-14)

**Lead:** Keaton  
**Status:** DECISION REQUIRED

Users are confused about the distinction between "Done" and "Archived" states in DevDocket. Need to clarify:
1. **Done → Archived lifecycle** — Should Done items automatically archive after N days, or require explicit user action?
2. **User-facing semantics** — Is "Done" = finished vs "Archived" = never see again?
3. **Provider closure signals** — Should GitHub issue closure auto-mark DevDocket item Done?
4. **History view organization** — Should Done and Archived appear together or in separate sections?

**Current Model:** Two terminal states in WorkItem state machine (Done and Archived) but unclear user-facing purpose and transition rules.

**Action Required:** Keaton to write design decision document clarifying semantics and transition rules, then Fenster implements based on clarified intent.

**References:**
- First issue to surface this UX confusion
- Decision document location: `.squad/decisions.md` (this entry)

---

### BasePrAction Extraction Pattern (2026-07-22)

**Author:** Fenster (Extension Dev)  
**Status:** Implemented

Shared PR action logic (diff fetching, GitHub auth, LLM model selection, prompt loading with custom file support, workspace path validation) is extracted into `BasePrAction` in `basePrAction.ts`. `AiReviewAction` extends this base class and provides configuration properties plus a `getRuntimeInstructions()` method, while `AiWalkthroughAction` is a standalone `DevDocketAction` that prepares a worktree and opens the `@walkthrough` chat participant.

**Rationale:**
- Eliminates code duplication across AI actions that all follow the same fetch-diff → confirm → analyze → display pattern
- New actions require ~25 lines instead of ~240, reducing bug surface
- The code review action (`AiReviewAction`) has its own VS Code configuration section (`devdocketAiReview`) for a custom prompt path
- The walkthrough action (`AiWalkthroughAction`) uses the `@walkthrough` chat participant with a built-in prompt and has no custom prompt config
- Re-exporting `sanitizePrUrl` from `aiReviewAction.ts` preserves test backward compatibility without requiring test refactoring

**Implementation:**
- `packages/ai-reviewer/src/basePrAction.ts` — Added base class for shared PR action logic (used by code review)
- `packages/ai-reviewer/src/aiReviewAction.ts` — Refactored into a thin subclass of `BasePrAction`
- `packages/ai-reviewer/src/aiWalkthroughAction.ts` — Added lightweight action that prepares worktree and opens `@walkthrough` chat
- `packages/ai-reviewer/src/walkthroughParticipant.ts` — Chat participant with tool-use loop
- `packages/ai-reviewer/src/walkthroughPrompt.ts` — Interactive walkthrough prompt builder
- `packages/ai-reviewer/src/repoManager.ts` — Git clone + worktree management
- `packages/ai-reviewer/src/tools/` — 6 LM tools for repo access
- `packages/ai-reviewer/src/defaultPrompt.ts` — Updated review prompt with superpowers content
- `packages/ai-reviewer/src/extension.ts` — Registers both actions, chat participant, and LM tools
- `packages/ai-reviewer/package.json` — Updated metadata, added chatParticipants + languageModelTools contributions

**Test Coverage:** Existing review action coverage plus new walkthrough, participant, tool, and RepoManager tests — all passing at implementation time
**Result:** All relevant test suites passing at implementation time

**References:**
- Issue #12
- `packages/ai-reviewer/src/basePrAction.ts`
- `packages/ai-reviewer/src/aiReviewAction.ts`
- `packages/ai-reviewer/src/extension.ts`

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

### Issue #189 — Dismissed Items Resurfacing Fix (2026-04-11)

**Lead:** Fenster (Extension Dev)  
**Tester:** Hockney (Tester)  
**Status:** Fixed & Verified

**Problem:** Dismissed items re-appeared in inbox on subsequent provider refreshes.

**Root Cause:** PR review providers (`GitHubPrReviewProvider`, `AdoPrReviewProvider`) had `resurfaceDismissed = true`, which caused `handleDiscoveredItems()` to overwrite dismissed items back to `unseen` on every provider refresh.

**Solution:** Removed `resurfaceDismissed` entirely from the codebase. Dismissed items should never be resurfaced by any provider.

**Note:** An initial misdiagnosis attributed the bug to a cache race condition in `DiscoveredStateStore.getState()`. That theory was incorrect — the real cause was the explicit resurface logic.

---

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
