# Fenster — Extension Dev — History

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
- `src/storage/jsonTaskStore.ts` — persistence (implements ITaskStore from `src/storage/taskStore.ts`)
- `src/views/` — inboxTreeProvider, focusTreeProvider, workItemEditorPanel
- `src/commands/commands.ts` — all command registrations
- `src/extension.ts` — activation entry point
- `vitest.config.ts` — test config
- `package.json` — contributes views, commands, menus

## Learnings

- GitHub package (`packages/github/`) vscode mock lives at `packages/github/src/test/__mocks__/vscode.ts`, aliased in `vitest.config.ts` — mirrors core mock pattern but adds `authentication`, `workspace`, `extensions` mocks.
- Mock includes: `authentication.getSession` (resolves with `{ accessToken: 'mock-token' }`), `workspace.getConfiguration` (returns `.get(key, default)` stub), `workspace.workspaceFolders`, `extensions.getExtension`, `commands.executeCommand`, `Uri.file`, `window.showErrorMessage`.
- Root `npm install` handles all workspace deps via npm workspaces. Root `npm run build` runs esbuild in both packages.
- Both packages use esbuild with `--external:vscode --format=cjs --platform=node`.
- Core has 38 tests (4 test files). GitHub package has test infra ready but no test files yet.
- Key github source files: `githubProvider.ts` (fetches GitHub issues via REST API), `startWorkAction.ts` (creates git branch + worktree), `extension.ts` (acquires core API, registers provider + action).

## Phase 2 Completion (2026-03-24)

**Status:** COMPLETE — Infrastructure and builds verified.
- Created GitHub vscode mock with authentication, workspace, extensions mocks
- Ran npm install and npm run build — all workspace deps resolved, both packages built successfully
- Verified esbuild output for core and github packages
- Ready for Phase 3 planning

## Phase 3: Inbox/Sources Discovery System

**Status:** COMPLETE — All 10 implementation steps done, build passes, 64/64 tests pass.

### Learnings

- **InboxState enum** (`unseen | accepted | dismissed`) persisted as `discovered-state.json` alongside `workitems.json`. DiscoveredStateStore uses same ENOENT/mkdir pattern as JsonTaskStore but adds a vscode.EventEmitter for change notifications.
- **ProviderRegistry no longer creates WorkItems.** Providers store discovered items in an in-memory Map; WorkItem creation only happens through explicit user actions (accept commands). Constructor now takes `(workGraph, stateStore)`.
- **Tree element types differ per view:** Inbox uses `InboxItem` (flat DiscoveredItem + providerId), Sources uses a discriminated union (`SourceProviderNode | SourceGroupNode | SourceItemNode`), Queue/Focus still use `WorkItem`. Command handlers receive these element types directly from VS Code tree clicks.
- **Migration pattern:** On activation, scan existing WorkItems with providerId+externalId and write `accepted` entries to stateStore before registering tree providers. This prevents re-surfacing already-accepted items.
- **Dismissed items are sticky** — the stateStore check in `handleDiscoveredItems` only writes `unseen` for items with no existing state, preserving `dismissed` and `accepted`.
- **`openInBrowser` command** updated to handle both WorkItem (via `item.id` lookup) and discovered items (direct `item.url` fallback).
- **GitHub provider** now sets `group: owner/repo` parsed from `html_url` via regex, enabling Sources tree grouping by repository.

### Key New Files
- `src/storage/discoveredStateStore.ts` — InboxState persistence + change events
- `src/views/queueTreeProvider.ts` — renamed from old InboxTreeProvider (shows WorkItems in New state)
- `src/views/inboxTreeProvider.ts` — NEW, shows unseen DiscoveredItems from all providers
- `src/views/sourcesTreeProvider.ts` — hierarchical Provider → Group → Item tree

## Learnings (Updated 2026-03-24)

### File Structure and Conventions
- DiscoveredStateStore follows same ENOENT/mkdir pattern as JsonTaskStore for consistent file handling
- Tree provider element types vary per view: flat InboxItem (inbox), union discriminated types (sources), WorkItem (queue/focus)
- Command handlers receive element types directly from VS Code tree clicks — no need to re-fetch from store

### Event-Driven Architecture
- DiscoveredStateStore and ProviderRegistry both fire change events — views subscribe to both for immediate UI updates
- Provider refresh and user actions (accept/dismiss) both trigger onDidChange events for reliable view synchronization

### Sticky State Semantics
- Dismissed items marked in state store are never cleared by provider refresh — dismissal is a permanent user preference
- Migration logic runs on activation before tree registration to seed existing WorkItems as 'accepted'
- Items with no persisted state default to 'unseen' — allows new providers to introduce items without re-surfacing old ones

## Code Review Fixes (2026-03-24)

Fixed all Critical (C1-C7) and Important (I1-I8) issues from Keaton's review for PR #1:

### Critical Patterns
- **Loading flag management**: Must clear on both success and error paths. The `handleDiscoveredItems` method now clears loading flag after firing discovery event.
- **Async state writes**: Always `await` state store writes in loops to prevent silent failures.
- **Migration error handling**: Wrap each iteration in try-catch to continue even if individual setState fails.
- **API type safety**: Use `typeof api.method !== 'function'` instead of truthiness checks to validate extension APIs.
- **In-memory cache for storage**: Maintain cache as source of truth to avoid read-modify-write races. `JsonTaskStore` now uses `Map<string, WorkItem>` cache.
- **Git branch safety**: Check if branch exists before creation (`git branch --list <name>`). Delete branch on worktree failure for rollback.
- **Path construction**: Use `path.join()` for cross-platform paths, never string concatenation.

### Important Patterns
- **Auth cancellation**: GitHub auth can be cancelled by user. Catch rejection with `.catch(() => null)` and guard against null session.
- **User-facing errors**: Accumulate fetch failures and show a single notification instead of just console logging.
- **View message timing**: Check `getAllDiscoveredItems().size > 0` instead of `hasProviders` to avoid race where providers register before items load.
- **Immutable updates**: Clone before mutating (`{ ...item, ...patch }`) to prevent inconsistent state if save fails.
- **Rollback patterns**: If multi-step operation fails partway (branch created but worktree fails), clean up partial state.
- **Defensive checks**: Check `fs.existsSync()` for worktree directory before attempting creation to give better error messages.
- **Stable external IDs**: Use format like `owner/repo#123` that survives issue transfers, not `html_url` which can change.

### Skipped Issues
- **I3 (contextValue naming)**: Pattern `item.url ? 'inboxItem.hasUrl' : 'inboxItem'` was already consistent across views. No change needed.

