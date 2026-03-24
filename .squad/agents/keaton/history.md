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
