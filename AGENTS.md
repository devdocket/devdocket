# DevDocket VS Code Extension Agent Instructions

> **⚠️ BEFORE making any code changes:** (1) Create a git worktree and feature branch — never modify files directly in the main working tree (see [Use git worktrees for feature branches](#use-git-worktrees-for-feature-branches)). (2) Start a DevDocket bot session so commits, pushes, and `gh` calls are attributed to the bot, not to the developer (see [DevDocket bot identity for local Copilot CLI work](#devdocket-bot-identity-for-local-copilot-cli-work)).

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
- **`devdocket.inbox-state`** — Thin index mapping `providerId + externalId` → `InboxState` (`unseen` | `accepted` | `dismissed`). Provider item data (title, description, url) is **not persisted** — always read live from the provider.

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

Providers emit `ProviderItem[]` via events. Actions declare `canRun(item)` and are surfaced dynamically via the editor's **Run Action…** button.

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

Stores like `JsonTaskStore` and `InboxStateStore` write through `globalState.update(...)`, which VS Code treats as atomic from the extension's perspective. There is **no** write-queue or file-level locking. See `.github/instructions/storage.instructions.md` for the full convention.

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

- `packages/core/src/api/types.ts` — `DevDocketApi`, `DevDocketProvider`, `DevDocketAction`, and re-exported shared types (`Disposable`, `Event`, `ProviderItem`)
- `packages/core/src/models/workItem.ts` — `WorkItem` and `WorkItemState` (`WorkItem` is exposed to action implementors via `DevDocketAction.canRun` / `run`, and references `WorkItemState`)
- `packages/shared/src/baseProvider.ts` — `ProviderItem`, `Disposable`, `Event`, `EventEmitterLike`, `BaseProvider`
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
- **Ensure a DevDocket bot session is active before pushing or running any `gh` command that creates/modifies remote state** (PRs, issues, comments, reviews, labels, assignments). See [DevDocket bot identity for local Copilot CLI work](#devdocket-bot-identity-for-local-copilot-cli-work). If the bot session cannot be started (missing App ID / private key), STOP and ask the user how to proceed — do NOT silently fall back to the developer's identity.
- **Any code change re-triggers the local loop** — whether from code review, Copilot feedback, CI fix, or conflict resolution.
- **Use `superpowers:code-reviewer` agent** for code review, not a generic code-review agent.
- **Add a `.changeset/*.md` file when the PR changes user-facing behavior of a publishable package.** See [Releases & Changesets](#releases--changesets) for the required format, when a changeset is and isn't needed, and the exact package names to use.
- When working on multiple issues in parallel, each issue goes through this full cycle independently in its own worktree.

> **Without Copilot CLI:** Manually rebase on `dev`, run `npm run build && npm run test`, open a PR with `gh pr create --base dev`, and request review from `copilot-pull-request-reviewer`.

## Releases & Changesets

This repo uses [Changesets](https://github.com/changesets/changesets) for per-package versioning, changelog generation, and automated VS Code Marketplace / GitHub Packages publishing. **Every PR that changes user-facing behavior of a publishable package MUST include a `.changeset/*.md` file** describing the change.

> Maintainers operating the release pipeline (reviewing/merging Version Packages PRs, approving publish runs, recovering from failures, setting up infrastructure) should refer to [RELEASING.md](RELEASING.md). This section covers only the contributor/agent task of producing the `.changeset/*.md` file.

### When a changeset is required

**Required** for any change to one of the following packages that is user-facing — a new feature, bug fix, behavior change, performance improvement, deprecation, or API change:

| Directory | Package name to use in changeset |
|-----------|----------------------------------|
| `packages/shared` | `@devdocket/shared` |
| `packages/core` | `devdocket` |
| `packages/github` | `devdocket-github` |
| `packages/ado` | `devdocket-ado` |
| `packages/start-git-work` | `devdocket-start-git-work` |
| `packages/ai-reviewer` | `devdocket-ai-reviewer` |

Do not include `devdocket-monorepo` — it's ignored in `.changeset/config.json`.

**Not required** for:
- Documentation-only changes (README, AGENTS.md, `.github/instructions/*`, `docs/*`)
- CI / workflow / changeset config changes (`.github/workflows/*`, `.changeset/config.json`, scripts under `scripts/`)
- Pure refactors with zero behavior change
- Test-only changes
- Internal-only changes that don't affect any consumer of the package

CI emits a non-blocking warning if no changeset is present — the warning is fine for the legitimately changeset-less cases above. Don't add a changeset just to silence the warning.

### How to add a changeset (agents)

Agents must NOT use the interactive `npx changeset` CLI — it prompts for package selection, bump types, and a summary. Create the changeset file directly instead:

1. **Pick a unique filename** under `.changeset/`. Use a short kebab-case description of the change (e.g., `.changeset/fix-pr-watch-grouping.md`, `.changeset/add-walkthrough-anchor.md`). Before writing, check that no other open PR is using the same filename — collisions cause merge conflicts in `.changeset/`.
2. **Write the file** with this exact format:

   ```md
   ---
   "<package-name-1>": <bump-type>
   "<package-name-2>": <bump-type>
   ---

   <One- or two-sentence user-facing description of the change. This text becomes the CHANGELOG entry and the GitHub Release note.>
   ```

3. **Commit the file as part of the feature PR** (same branch, any commit — typically the final commit of the work). Do not open a separate PR just for the changeset.

### Bump types

- `patch` — bug fixes, internal improvements, dependency bumps that don't change observable behavior
- `minor` — new features, new APIs, deprecations (still backward compatible)
- `major` — breaking changes to the public API (see `.github/instructions/api-surface.instructions.md` for what counts as breaking for `@devdocket/shared` and `devdocket`)

When in doubt, choose the smaller bump.

### Internal dependencies are auto-bumped

`.changeset/config.json` sets `updateInternalDependencies: patch`, so if you bump `@devdocket/shared`, every extension that depends on it receives a `patch` bump automatically. **Do not list the dependents in the changeset just to bump them** — Changesets handles this. Only list a dependent package if the change has its own user-facing behavior change in that package.

### Example changesets

Bug fix in core only:

```md
---
"devdocket": patch
---

Fix PR watch cards being grouped into the wrong section when a PR has multiple recent runs.
```

New feature touching two extensions and the shared library, where the shared change is user-facing for both extensions:

```md
---
"@devdocket/shared": minor
"devdocket-github": minor
"devdocket-ado": minor
---

Add `RelatedItemRef.kind` so providers can distinguish issues from pull requests in related-item links.
```

Breaking API change:

```md
---
"@devdocket/shared": major
---

Remove the deprecated `DiscoveredItem` interface. Provider extensions must now emit `ProviderItem`. See the PR description for migration notes.
```

### What happens after the PR merges

You do NOT bump versions or edit `CHANGELOG.md` files manually — Changesets owns both. After your PR with a `.changeset/*.md` merges to `dev`:

1. The dedicated `devdocket bot` GitHub App detects pending changesets and opens (or updates) a single **Version Packages** PR against `dev` that bumps versions in each affected `package.json` and writes per-package `CHANGELOG.md` entries.
2. When a maintainer merges that Version Packages PR, the Changesets workflow's publish step runs `scripts/create-release-tags.mjs`, which fast-forwards `main` to `dev`'s HEAD and creates per-package release tags **on `main`** (e.g., `shared-v0.2.0`, `core-v1.1.0`). The tagged commit is reachable from both `main` and `dev`. The dedicated `devdocket bot` GitHub App pushes `main`, and the workflow creates tag refs via the REST API (not the default `GITHUB_TOKEN`), which is what allows the next step to fire.
3. Each tag push triggers the matching per-package publish workflow (`publish-shared.yml`, `publish-core.yml`, `publish-github.yml`, `publish-ado.yml`, `publish-start-git-work.yml`, `publish-ai-reviewer.yml`). The extension workflows publish to the VS Code Marketplace via Microsoft Entra ID OIDC (gated by the `marketplace-publish` GitHub Environment — if required reviewers are configured there, each publish pauses for approval). The shared workflow publishes `@devdocket/shared` to GitHub Packages. All publishes happen in parallel, each creating its own GitHub Release.

So merging the Version Packages PR is the single human action that triggers the entire release cascade for every affected package. If you ever find yourself manually editing a `package.json` `version` field or a `CHANGELOG.md` file, stop — that's almost certainly the wrong action. Use a changeset instead.

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

### DevDocket bot identity for local Copilot CLI work

When a Copilot CLI agent does work on a developer's behalf, the resulting commits, PRs, and issues **must** be attributed to the DevDocket bot (the same GitHub App identity used by the Changesets workflow), not to the developer.

**When to start a bot session (mandatory):**

Agents MUST run the bot-session helper at the very start of any task that will:

- make a `git commit` in the worktree, or
- run a `gh` command that creates or modifies remote state — including (but not limited to) `gh pr create`, `gh pr comment`, `gh pr review`, `gh pr edit`, `gh issue create`, `gh issue comment`, `gh issue edit`, `gh api` calls with `-X POST/PATCH/PUT/DELETE`, `gh release create`, etc.

Read-only `gh` calls (`gh issue view`, `gh pr view`, `gh pr diff`, `gh run list`, `gh api` GETs) do not require a bot session, but it's fine to start one preemptively. When in doubt, start the session before doing anything that could touch remote state.

The session must be started **before** any committing/pushing/PR work. Starting it after the fact does not re-attribute prior commits.

**Helper script:**

A helper mints a short-lived (≤ 1 hour) installation access token from the bot's GitHub App and configures the current shell to use that identity for subsequent `gh` and `git` calls:

```bash
# bash / zsh
eval "$(node scripts/start-bot-session.mjs --shell=bash)"

# PowerShell
node scripts/start-bot-session.mjs --shell=powershell | Invoke-Expression
```

The script requires the GitHub App ID and the private key. The private key can be provided either inline as PEM contents or as a path to a `.pem` file on disk — pick one:

- `DEVDOCKET_BOT_APP_ID` — the numeric GitHub App ID.
- `DEVDOCKET_BOT_APP_PRIVATE_KEY` — the GitHub App private key (PEM contents, including the `-----BEGIN/END PRIVATE KEY-----` markers). _Or:_
- `DEVDOCKET_BOT_APP_PRIVATE_KEY_PATH` — filesystem path to the `.pem` file. The script reads it on every invocation; the file is never copied or cached.

The inline `DEVDOCKET_BOT_APP_PRIVATE_KEY` matches the name of the GitHub Actions repository secret used by the bot's workflows, so the same value can be reused locally. `DEVDOCKET_BOT_APP_PRIVATE_KEY_PATH` is more convenient when you already keep the key on disk. After running the helper, the working tree's `user.name` / `user.email` and `GH_TOKEN` / `GITHUB_TOKEN` point at the bot for the lifetime of that shell; opening a new shell reverts to the developer's normal identity.

Recommended export idioms:

```bash
# bash / zsh — inline PEM
export DEVDOCKET_BOT_APP_ID=123456
export DEVDOCKET_BOT_APP_PRIVATE_KEY="$(cat path/to/devdocket-bot.pem)"

# bash / zsh — path to PEM file
export DEVDOCKET_BOT_APP_ID=123456
export DEVDOCKET_BOT_APP_PRIVATE_KEY_PATH=path/to/devdocket-bot.pem
```

```powershell
# PowerShell — inline PEM
$env:DEVDOCKET_BOT_APP_ID = '123456'
$env:DEVDOCKET_BOT_APP_PRIVATE_KEY = Get-Content -Raw path\to\devdocket-bot.pem

# PowerShell — path to PEM file
$env:DEVDOCKET_BOT_APP_ID = '123456'
$env:DEVDOCKET_BOT_APP_PRIVATE_KEY_PATH = 'path\to\devdocket-bot.pem'
```

If your secret store delivers the PEM as a single line with literal `\n` escapes (common with 1Password / Vault / CI UI copy-paste), the helper auto-normalizes them to real newlines.

**Verify the session is active** before proceeding:

```bash
git config user.email   # should end in @users.noreply.github.com (bot's noreply address)
gh api /repos/devdocket/devdocket --jq .full_name  # should succeed; do NOT use `gh api user`,
                                                   # installation tokens 403 on /user
```

If either check fails (e.g., still shows the developer's identity), the bot session is not active and the helper either errored out or its output was not applied to the current shell — fix that before continuing.

> **Note:** an installation token returns 403 on `GET /user` ("Resource not accessible by integration"), so do NOT use `gh api user` to verify. Use a repo-scoped call like the one above instead. A 403 from `gh api user` after starting a bot session is expected, not a failure.

**If the bot session cannot be started** (helper prints "App ID not found", "Private key not found", expired key, etc.): STOP. Do not fall back to the developer's identity. Report the failure to the user and ask how to proceed — typically the user needs to export `DEVDOCKET_BOT_APP_ID` and either `DEVDOCKET_BOT_APP_PRIVATE_KEY` or `DEVDOCKET_BOT_APP_PRIVATE_KEY_PATH` in their environment.

**⚠️ Bot session env vars do NOT persist across sync shell invocations.** Many Copilot CLI shell tools (e.g., `powershell` in sync mode) create a fresh shell per call and discard `$env:GH_TOKEN` / `$env:GITHUB_TOKEN` set by a previous call. The `git config` changes made by the helper are persistent in the worktree (they live in `.git/config`), so commits stay bot-authored — but `gh` calls in a fresh shell will use the developer's cached `gh auth` credential and create PRs/comments/issues under the developer's account.

To avoid this, choose one of these patterns:

1. **Single-shell chain (preferred for one-off `gh` actions):** Run the helper and the `gh` command in the same tool invocation, e.g.:
   ```powershell
   cd <worktree>
   node scripts/start-bot-session.mjs --shell=powershell | Invoke-Expression
   gh pr create --base dev --title "..." --body-file pr-body.md
   ```
2. **Long-lived async shell:** Start an async/persistent shell, run the helper there once, then send subsequent `gh` / `git` commands into the same shell (e.g. Copilot CLI's `powershell` with `mode: "async"`). All subsequent calls share the same `$env:GH_TOKEN`.

**Always verify** after creating any remote artifact that the actor is the bot, not the developer:

```bash
gh pr view <number> --json author --jq .author.login   # should be "app/devdocket-bot"
```

If a PR / issue / comment was accidentally created as the developer, close it and recreate with the bot session active.

**Sub-agents:** The orchestrating agent is responsible for starting the bot session in each worktree before dispatching sub-agents that will commit/push/`gh`-create. Sub-agents inherit the parent shell's environment only when they share it; if a sub-agent runs in a separately spawned shell, that shell must independently run the helper (or the orchestrator must export the resulting env vars to it).

Note: commits made in the working tree will be **authored** by the bot, but `git push` over HTTPS still uses the developer's stored credential helper — so the *pusher* recorded on GitHub is the developer. Use `gh pr create` / `gh issue create` / other `gh` subcommands for remote actions that need bot attribution; those consume `GH_TOKEN` directly.

### Delegate exploration and implementation to sub-agents

When working on multiple independent tasks (e.g., fixing several unrelated bugs), **do not** manually explore the codebase yourself before dispatching agents. Instead, delegate the work immediately — each sub-agent is responsible for its own exploration, understanding, implementation, and testing. The orchestrating agent's job is to:

1. Read the issue descriptions to understand scope and independence.
2. Read any relevant instruction or convention documents needed to understand repo rules and delegate correctly.
3. Dispatch sub-agents with full context (issue description, relevant file paths, conventions).
4. Wait for results, then validate (run the full test suite, review if needed).

Do not pre-read source files or test files "just to understand" before delegating, except for minimal inspection needed to identify ownership or routing. Instruction files and convention documents may be read when needed to provide sub-agents with accurate context and constraints.
