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
