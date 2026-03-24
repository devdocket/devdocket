# WorkCenter VS Code Extension Agent Instructions

## Build & Test

```bash
# Build all packages
npm run build

# Test all packages
npm run test

# Build/test a single package
cd packages/core && npm run build
cd packages/github && npm run build

# Run a single test file
cd packages/core && npx vitest run src/test/workGraph.test.ts

# Watch mode (rebuilds on save)
cd packages/core && npm run watch
```

## Architecture

WorkCenter is a VS Code extension that acts as a **hub** for managing work items from multiple sources. It's a monorepo with two extensions:

- **`packages/core`** — The WorkCenter extension. Owns the UI, work item lifecycle, and plugin API.
- **`packages/github`** — A provider extension that discovers GitHub issues and offers a "Start Work" action (branch + worktree + new window).

### Data flow

```
Providers (GitHub, future)          User (manual)
        │                                │
        ▼                                ▼
  ProviderRegistry ──▶ Inbox ──▶ Queue ──▶ Focus
  (live references)    (unseen)  (accepted) (in progress)
        │
        ▼
     Sources
  (browsable library)
```

### Four views

1. **Inbox** — Newly discovered provider items (state: `unseen`). Accept → Queue or Dismiss.
2. **Queue** — User's curated backlog. Manual items land here directly.
3. **Focus** — Active work (`InProgress`, `Blocked`, `WaitingOn`).
4. **Sources** — Everything providers know about, grouped by provider → sub-group. Always browsable.

### Two data stores (both JSON files in `globalStorageUri`)

- **`workitems.json`** — Persisted WorkItems with state machine lifecycle (`New` → `InProgress` → `Done` → `Archived`).
- **`discovered-state.json`** — Thin index mapping `providerId + externalId` → `InboxState` (`unseen` | `accepted` | `dismissed`). Provider item data (title, description, url) is **not persisted** — always read live from the provider.

### Extension API

The core extension returns `WorkCenterApi` from `activate()`. Provider extensions acquire it via `vscode.extensions.getExtension('mthalman.workcenter')`.

```ts
interface WorkCenterApi {
  registerProvider(provider: WorkCenterProvider): Disposable;
  registerAction(action: WorkCenterAction): Disposable;
}
```

Providers emit `DiscoveredItem[]` via events. Actions declare `canRun(item)` and are surfaced dynamically in context menus.

## Key Conventions

### vscode module is mocked for tests

Tests run outside VS Code via vitest. The `vscode` import is aliased to `src/test/__mocks__/vscode.ts` in each package's `vitest.config.ts`. When adding new VS Code APIs to source code, add corresponding mocks.

### Provider items are references, not copies

Items in Inbox and Sources are read live from the provider's in-memory data. The only persisted state is the `inboxState` enum. This keeps data fresh and avoids stale copies.
