# DevDocket VS Code Extension Agent Instructions

> **⚠️ BEFORE making any code changes:** Create a git worktree and feature branch. Never modify files directly in the main working tree. See [Use git worktrees for feature branches](#use-git-worktrees-for-feature-branches).

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
- **`packages/github`** — A provider extension that discovers GitHub issues, mentions, PR reviews, and pull requests you authored or are assigned to, plus a GitHub Actions and PR watcher.
- **`packages/ado`** — A provider extension that discovers Azure DevOps work items, PR reviews, and authored PRs, plus an ADO Pipelines and PR watcher.
- **`packages/start-git-work`** — An action extension that creates git branches and worktrees for work items from GitHub and ADO providers.
- **`packages/ai-reviewer`** — An action extension that runs AI-powered code review against the diff of a GitHub PR work item, plus an `@walkthrough` chat participant for guided codebase tours.
- **`packages/shared`** — Shared library (BaseProvider, type definitions, signal/concurrency utilities) consumed by all extensions and published to GitHub Packages as `@devdocket/shared`.

### Data flow

```
Providers (GitHub, ADO, …)         User (manual)
        │                                │
        ▼                                ▼
  ProviderRegistry ──▶ Incoming ──▶ Ready to Start ──▶ In Progress ──▶ Done
  (live references)    (unseen)     (accepted/New)      (InProgress)     (Done/Archived)
        │
        ▼
     Sources
  (browsable library)
```

These are the conceptual lifecycle stages tracked internally as `WorkItemState` and `InboxState`. The UI renders them as tiers in a single webview-based sidebar (see below) — there are no separate VS Code tree views per stage.

### Sidebar UI (single webview view: `devdocket.main`)

The main UI is a Preact-based webview view ID-ed `devdocket.main` with two tabs:

1. **My Work** — five tiers in this render order:
   1. **↓ Incoming** — newly discovered provider items with `inboxState === 'unseen'`.
   2. **▶ In Progress** — work items in `WorkItemState.InProgress`.
   3. **○ Ready to Start** — work items in `WorkItemState.New` (the "queue" concept).
   4. **⏸ Paused** — work items in `WorkItemState.Paused`.
   5. **✓ Done** — work items in `WorkItemState.Done` or `Archived`.
2. **Sources** — everything providers know about, grouped by provider → sub-group. Always browsable.

Plus a floating **CI Watches** panel (separate `devdocket.watchPanel` webview) for monitoring GitHub Actions / ADO Pipelines runs and PR status.

User-facing terminology: **never** use the legacy view names ("Inbox view", "Queue view", "Focus view", "History view") in user-facing strings, walkthroughs, or docs. Use tier names ("Incoming tier", "Ready to Start tier", etc.) or "the DevDocket sidebar" for the whole. Internal docs/code may still refer to "inbox state" / "queue" as concepts where that's clearer.

### Two persisted stores (both backed by VS Code `globalState`)

- **`devdocket.workitems`** — Persisted `WorkItem` records with state machine lifecycle (`New` → `InProgress` → `Done` → `Archived`).
- **`devdocket.discovered-state`** — Thin index mapping `providerId + externalId` → `InboxState` (`unseen` | `accepted` | `dismissed`). Provider item data (title, description, url) is **not persisted** — always read live from the provider.

See `.github/instructions/storage.instructions.md` for the full storage contract (including the read-state, provider-labels, and watches keys).

### Extension API

The core extension returns `DevDocketApi` from `activate()`. Provider extensions acquire it via `vscode.extensions.getExtension('devdocket.devdocket')`.

```ts
interface DevDocketApi {
  registerProvider(provider: DevDocketProvider): Disposable;
  registerAction(action: DevDocketAction): Disposable;
  // (plus optional registerRunWatcher, registerPRWatcher, addActivity,
  //  and onDidTransitionState — see docs/extension-api.md for the full surface)
}
```

Providers emit `DiscoveredItem[]` via events. Actions declare `canRun(item)` and are surfaced dynamically via the editor's **Run Action…** button.

## Key Conventions

### Default branch is `dev`

All work should be based from the `dev` branch. Create feature branches from `dev` and PR back to `dev`.

### Use git worktrees for feature branches

Always use `git worktree` to work on feature branches instead of switching branches in the main checkout. This keeps the main working tree on `dev` and avoids disrupting other work. Use the `using-git-worktrees` skill when available.

```bash
# Create a worktree for a feature branch
git worktree add ../devdocket-description-sync-391 -b description-sync-391 dev

# Work in the worktree
cd ../devdocket-description-sync-391

# Clean up after merging
git worktree remove ../devdocket-description-sync-391
```

Never use `git checkout` or `git switch` to move the main working tree off `dev`.

**This applies to sub-agents too.** When dispatching sub-agents for independent tasks, the orchestrating agent must create a worktree and feature branch for each sub-agent *before* dispatching, and instruct each sub-agent to work exclusively in its assigned worktree. Sub-agents must never make changes directly in the main working tree. The orchestrating agent is responsible for worktree setup and cleanup — sub-agents just receive a working directory path.

### Use merge commits, not rebase

When resolving merge conflicts or syncing with `dev`, use `git merge origin/dev` instead of `git rebase`. This preserves commit history and avoids force-push issues.

### Storage writes rely on `Memento.update` atomicity

Stores like `JsonTaskStore` and `DiscoveredStateStore` write through `globalState.update(...)`, which VS Code treats as atomic from the extension's perspective. There is **no** write-queue or file-level locking. See `.github/instructions/storage.instructions.md` for the full convention.

### vscode module is mocked for tests

Tests run outside VS Code via vitest. The `vscode` import is aliased to `src/test/__mocks__/vscode.ts` in each package's `vitest.config.ts`. When adding new VS Code APIs to source code, add corresponding mocks.

### Provider items are references, not copies

Items in the Incoming tier and Sources tab are read live from the provider's in-memory data. The only persisted state is the `inboxState` enum. This keeps data fresh and avoids stale copies.

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
- **Never skip or shortcut the process.** Every PR goes through all phases. Do NOT push branches or create PRs via `gh pr create` until the `create-pr` skill's Phase 1 (local loop) is complete.
- **Invoke the `create-pr` skill before creating any PR.** The skill must be loaded and its phases followed in order. Never hand-roll `gh pr create` or `git push` without the skill orchestrating it.
- **Any code change re-triggers the local loop** — whether from code review, Copilot feedback, CI fix, or conflict resolution.
- **Use `superpowers:code-reviewer` agent** for code review, not a generic code-review agent.
- When working on multiple issues in parallel, each issue goes through this full cycle independently in its own worktree.

> **Without Copilot CLI:** Manually rebase on `dev`, run `npm run build && npm run test`, open a PR with `gh pr create --base dev`, and request review from `copilot-pull-request-reviewer`.

## Design Conventions

### Activity log as source of truth

Whenever possible, use the item activity log to derive data rather than storing new metadata on WorkItem. The activity log should be the source of truth for historical data (e.g., branch/worktree associations, state change history, action records). Only add new fields to WorkItem when the data truly cannot be derived from the log.

### Core extension isolation

The core extension must not rely on anything from the other extensions (github, ado, start-git-work, ai-reviewer) beyond the contract defined in the API types. Core orchestrates, providers supply data — no direct imports or coupling beyond the published interfaces.

### Git commit and PR conventions

- Never include the issue number in a commit message. Issue references belong in the PR description only.
- Never include the issue number or branch name in the PR title. PR titles should be descriptive of the change.
- All PRs should reference in their description the issue they're fixing (e.g., `Closes #N`).
- When reading a GitHub issue to implement a fix, always read the issue description AND all posted comments — not just the issue body. Comments often contain design decisions, clarifications, and updated requirements.

### Delegate exploration and implementation to sub-agents

When working on multiple independent tasks (e.g., fixing several unrelated bugs), **do not** manually explore the codebase yourself before dispatching agents. Instead, delegate the work immediately — each sub-agent is responsible for its own exploration, understanding, implementation, and testing. The orchestrating agent's job is to:

1. Read the issue descriptions to understand scope and independence.
2. Read any relevant instruction or convention documents needed to understand repo rules and delegate correctly.
3. Dispatch sub-agents with full context (issue description, relevant file paths, conventions).
4. Wait for results, then validate (run the full test suite, review if needed).

Do not pre-read source files or test files "just to understand" before delegating, except for minimal inspection needed to identify ownership or routing. Instruction files and convention documents may be read when needed to provide sub-agents with accurate context and constraints.
