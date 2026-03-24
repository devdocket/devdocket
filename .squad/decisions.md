# Squad Decisions

## Active Decisions

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
