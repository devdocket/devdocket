# DevDocket VS Code Extension Agent Instructions

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

DevDocket is a VS Code extension that acts as a **hub** for managing work items from multiple sources. It's a monorepo with the following extensions:

- **`packages/core`** — The DevDocket extension. Owns the UI, work item lifecycle, and plugin API.
- **`packages/github`** — A provider extension that discovers GitHub issues and PR reviews.
- **`packages/ado`** — A provider extension that discovers Azure DevOps work items and PR reviews.
- **`packages/start-git-work`** — An action extension that creates git branches and worktrees for work items from GitHub and ADO providers.

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
3. **Focus** — Active work (`InProgress`, `Paused`).
4. **History** — Completed and archived items (`Done`, `Archived`).
5. **Sources** — Everything providers know about, grouped by provider → sub-group. Always browsable.

### Two data stores (both JSON files in `globalStorageUri`)

- **`workitems.json`** — Persisted WorkItems with state machine lifecycle (`New` → `InProgress` → `Done` → `Archived`).
- **`discovered-state.json`** — Thin index mapping `providerId + externalId` → `InboxState` (`unseen` | `accepted` | `dismissed`). Provider item data (title, description, url) is **not persisted** — always read live from the provider.

### Extension API

The core extension returns `DevDocketApi` from `activate()`. Provider extensions acquire it via `vscode.extensions.getExtension('mthalman.devdocket')`.

```ts
interface DevDocketApi {
  registerProvider(provider: DevDocketProvider): Disposable;
  registerAction(action: DevDocketAction): Disposable;
}
```

Providers emit `DiscoveredItem[]` via events. Actions declare `canRun(item)` and are surfaced dynamically in context menus.

## Squad Delegation

When acting as a squad member (e.g., "ralph, ...", "fenster, ..."), **delegate implementation work to sub-agents**. Do NOT explore the codebase or implement changes yourself. Each issue should be dispatched to the appropriate agent who will handle exploration, planning, and execution independently.

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

### Posting text to GitHub (backtick safety)

When posting ANY text to GitHub via `gh` CLI (PR descriptions, comments, review replies, issue comments), text containing backticks (`` ` ``) will be mangled by **both PowerShell and Python escape handling**. This applies to `--body`, `--fill`, `-f body=`, `gh pr comment`, `gh api`, etc.

**Always use this pattern:**
1. Write the text to a file using the `create` tool (which has zero escape interpretation)
2. Pass the file to `gh` via `--body-file`
3. Delete the temp file after

**Never** construct backtick-containing text inside Python strings, PowerShell strings, or inline shell arguments. The `create` tool is the only safe way to produce the file content.

### Extension API breaking change detection

During code review (via `superpowers:code-reviewer` or manual review), **any change to the public API surface must be evaluated for breaking changes**. Breaking changes must be flagged as **Critical** findings.

#### Public API surface files

These files define the contract that provider extensions depend on:

- `packages/core/src/api/types.ts` — `DevDocketApi`, `DevDocketProvider`, `DevDocketAction`, and re-exported shared types (`Disposable`, `Event`, `DiscoveredItem`)
- `packages/core/src/models/workItem.ts` — `WorkItem` and `WorkItemState` (`WorkItem` is exposed to action implementors via `DevDocketAction.canRun` / `run`, and references `WorkItemState`)
- `packages/shared/src/baseProvider.ts` — `DiscoveredItem`, `Disposable`, `Event`, `EventEmitterLike`, `BaseProvider`
- `packages/shared/src/index.ts` — all symbols exported from this barrel are considered public API surface of `@devdocket/shared`

#### What constitutes a breaking change

Any of the following applied to an exported interface, type, class, or function is a **breaking change**:

1. **Removing** a method, property, exported symbol, or enum member.
2. **Renaming** an exported symbol or enum member (type, interface, function, class, constant, enum value).
3. **Adding a required parameter** to an existing method or function (adding an *optional* parameter is safe).
4. **Changing the type** of an existing parameter, property, or return value in a way that is not a supertype widening.
5. **Changing an interface from optional to required** for any property (e.g. `foo?: string` → `foo: string`).
6. **Removing a re-export** from `packages/shared/src/index.ts` or `packages/core/src/api/types.ts`.
7. **Changing generic type parameters** (adding required generics, removing generics, changing constraints).
8. **Moving an exported symbol** to a different module path without preserving the old path as a re-export.

**Usually not breaking**: adding new optional properties, adding new exported symbols, adding new interfaces/types, widening an existing parameter type to a supertype, or adding new overload signatures only when they are appended and do not overlap with existing overload resolution. **Note:** widening a return type is often breaking for TypeScript consumers.

#### Code review requirements

- The reviewer **must** check all changed files against the API surface list above.
- Any detected breaking change **must** be reported as a **Critical** finding with the label `[API BREAKING CHANGE]`.
- If a breaking change is **intentional**, the PR description **must** include a `## Migration Notes` section documenting:
  - Which interfaces/types/exports changed and how.
  - What provider extensions need to update (code examples preferred).
  - The justification for the break.
- If a breaking change is found and the PR description lacks migration notes, the reviewer **must** block the PR and request they be added.

The `superpowers:code-reviewer` agent enforces this policy automatically; manual reviewers should follow the same checklist.

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
