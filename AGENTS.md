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
  ProviderRegistry ──▶ Inbox ──▶ Queue ──▶ Focus ──▶ History
  (live references)    (unseen)  (accepted) (in progress) (done/archived)
        │
        ▼
     Sources
  (browsable library)
```

### Five views

1. **Inbox** — Newly discovered provider items (state: `unseen`). Accept → Queue or Dismiss.
2. **Queue** — User's curated backlog. Manual items land here directly.
3. **Focus** — Active work (`InProgress`, `Blocked`, `WaitingOn`).
4. **History** — Completed and archived items (`Done`, `Archived`).
5. **Sources** — Everything providers know about, grouped by provider → sub-group. Always browsable.

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

### Default branch is `dev`

All work should be based from the `dev` branch. Create feature branches from `dev` and PR back to `dev`.

### Use merge commits, not rebase

When resolving merge conflicts or syncing with `dev`, use `git merge origin/dev` instead of `git rebase`. This preserves commit history and avoids force-push issues.

### Storage writes are serialized

Both `JsonTaskStore` and `DiscoveredStateStore` use a `writeQueue` (promise chain) to prevent concurrent writes from corrupting JSON files. Always follow this pattern for any new store.

### vscode module is mocked for tests

Tests run outside VS Code via vitest. The `vscode` import is aliased to `src/test/__mocks__/vscode.ts` in each package's `vitest.config.ts`. When adding new VS Code APIs to source code, add corresponding mocks.

### Provider items are references, not copies

Items in Inbox and Sources are read live from the provider's in-memory data. The only persisted state is the `inboxState` enum. This keeps data fresh and avoids stale copies.

### PR workflow — use the `create-pr` skill

When creating pull requests in an environment with [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli), **always invoke the `create-pr` skill** and follow its full multi-phase lifecycle. The `create-pr`, `copilot-pr-review`, and `superpowers:code-reviewer` references below are Copilot CLI skills and agents — they are available automatically when using Copilot CLI in this repository. Do NOT hand-roll a simplified version. The skill enforces:

- **Phase 1 (Local Loop):** Rebase on `dev`, run full test suite, dispatch `superpowers:code-reviewer` agent, fix findings, re-test, and repeat until tests pass AND review is clean.
- **Phase 2 (Create PR):** Push branch and open PR via `gh pr create --base dev`.
- **Phase 3 (Remote Loop):** Run Copilot PR review via `copilot-pr-review` skill, fix comments (one commit per comment), verify CI, resolve merge conflicts. Any code change in this phase triggers a re-run of Phase 1.

Key rules:
- **Never skip or shortcut the process.** Every PR goes through all phases.
- **Any code change re-triggers the local loop** — whether from code review, Copilot feedback, CI fix, or conflict resolution.
- **Use `superpowers:code-reviewer` agent** for code review, not a generic code-review agent.
- When working on multiple issues in parallel, each issue goes through this full cycle independently in its own worktree.

> **Without Copilot CLI:** Manually rebase on `dev`, run `npm run build && npm run test`, open a PR with `gh pr create --base dev`, and request review from `copilot-pull-request-reviewer`.
