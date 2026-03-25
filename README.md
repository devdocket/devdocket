# WorkCenter

**A unified work hub inside VS Code.**

WorkCenter is a VS Code extension that brings all of your work items — GitHub issues, PR review requests, investigations, follow-ups, and ad-hoc tasks — into a single, organized sidebar. Instead of juggling browser tabs, notification emails, and sticky notes, you manage everything from where you already write code.

## The Problem

Developers constantly context-switch between tools. Issues live in GitHub, tasks live in Jira, review requests arrive by email, and ad-hoc follow-ups exist only in your head. Each tool has its own UI, its own notification model, and its own idea of "what's next." The result: work falls through the cracks, and you waste time just figuring out what to do.

## How WorkCenter Helps

WorkCenter is **not** a replacement for GitHub Issues, Jira, or any other system of record. It is an **aggregation layer** that sits inside VS Code and gives you a personal, unified view of your work:

- **Providers** discover items from external sources (GitHub issues, PR reviews, and more in the future) and surface them automatically.
- **You** decide what to accept, what to dismiss, and what to work on next.
- **Actions** let provider extensions automate workflows — like creating a branch and worktree for a GitHub issue with one click.

## Quick Start

1. **Install WorkCenter** from the VS Code marketplace (`mthalman.workcenter`).
2. **Install a provider** — for example, WorkCenter GitHub (`mthalman.workcenter-github`) to discover GitHub issues and PR review requests.
3. **Open the WorkCenter sidebar** by clicking the WorkCenter icon in the activity bar.
4. **Check your Inbox** — newly discovered items from providers appear here. Accept items to add them to your Queue, or dismiss them.
5. **Work your Queue** — move items to Focus when you're ready to start, or create manual items with the ➕ button.
6. **Stay focused** — the Focus view shows only what you're actively working on. Mark items as blocked, waiting, or complete as you go.

### Configuring the GitHub Provider

After installing WorkCenter GitHub, configure which repositories to watch for issues:

```json
// settings.json
{
  "workcenterGithub.repos": ["owner/repo1", "owner/repo2"],
  "workcenterGithub.refreshIntervalSeconds": 300
}
```

Leave `repos` empty to fetch all issues assigned to you across all repositories.

> **Note:** The `repos` setting currently scopes **issue discovery only**. PR review requests are always discovered globally (all open PRs where your review is requested across all repositories).

## The Five-View Model

WorkCenter organizes work across five views in the sidebar:

### Inbox

Newly discovered items from providers that you haven't acted on yet. Each provider's items are grouped under the provider name. Accept items to move them to your Queue, or dismiss them to hide them from the Inbox.

### Queue

Your curated backlog. Items arrive here when accepted from the Inbox or Sources, or when you create them manually. All Queue items are in the **New** state. From here, move items to Focus to start working, or archive them to skip.

### Focus

Your active work. Items here are **InProgress**, **Blocked**, or **WaitingOn**. The Focus view is designed to show only what matters right now. Complete items when done, or mark them as blocked/waiting to signal status at a glance.

### History

Completed and archived items. The History view gives you a record of finished work — useful for standups, status updates, and recalling what you've done. Items here are in the **Done** or **Archived** state.

### Sources

A browsable library of everything providers know about, organized by provider and sub-group (e.g., repository name). Items show their inbox state — accepted items display a ✓ icon, dismissed items show a label. You can accept items into your Queue directly from Sources at any time.

### Data Flow

```
Providers (GitHub, etc.)          Manual creation
        │                               │
        ▼                               ▼
      Inbox  ────Accept────►  Queue  ───Move to Focus──►  Focus
                                │                           │
                              Archive                   Block/Wait
                                │                        ◄──►
                                │                      InProgress
                                │                           │
                                │                        Complete
                                ▼                           ▼
                              History ◄──────────────── History
                          (Archived)                    (Done)
```

> **Note:** Items in History can be restored — move them back to Queue or Focus to resume work.

## Plugin Ecosystem

WorkCenter is built around an extensible plugin model with two extension points:

### Providers

A provider discovers work items from an external source and reports them to WorkCenter. The core extension handles all UI — providers just emit data.

**Built-in providers** (via WorkCenter GitHub):

| Provider | What It Discovers |
|----------|-------------------|
| **GitHub Issues** | Issues assigned to you in configured repositories |
| **GitHub PR Reviews** | Pull requests where your review is requested |

### Actions

An action is an operation that runs on a work item. Actions appear in the **Run Action…** menu on Queue and Focus items.

**Built-in actions** (via WorkCenter GitHub):

| Action | Description |
|--------|-------------|
| **Start Work (Branch + Worktree)** | Creates a git branch and worktree for a GitHub issue, then opens a new VS Code window |

### Building Your Own

Provider and action extensions use a simple, well-defined API surface. See the [Extension API documentation](https://github.com/mthalman/workcenter/pull/29) for the full contract, interfaces, and example implementations. *(Added by [PR #29](https://github.com/mthalman/workcenter/pull/29); link will point to `docs/extension-api.md` once merged.)*

## Architecture

WorkCenter is a monorepo with two VS Code extensions:

```
packages/
├── core/       # WorkCenter — the hub extension (UI, lifecycle, plugin API)
└── github/     # WorkCenter GitHub — provider for issues and PR reviews
```

- **`packages/core`** owns the five views, work item persistence, the editor panel, and the extension API (`WorkCenterApi`).
- **`packages/github`** is a provider extension that discovers GitHub issues and PR reviews, and offers a "Start Work" action.

Provider extensions depend on the core extension via `extensionDependencies` and acquire the API at activation time. They do not import code from the core package directly — interfaces are re-declared to keep the extensions decoupled.

### Data Storage

WorkCenter persists two JSON files in VS Code's `globalStorageUri`:

- **`workitems.json`** — All accepted and manual work items with their full state machine lifecycle, including a snapshot of provider fields (such as `title`, `description`, and `url`) captured at accept time. These snapshots may become stale compared to live data from the provider.
- **`discovered-state.json`** — A thin index mapping `providerId + externalId` → inbox state (`unseen`, `accepted`, `dismissed`) for discovered items only. This file does not store provider item fields; for inbox items, provider data is read live from the provider.

## Documentation

- [UX Guide](https://github.com/mthalman/workcenter/pull/28) — The five views, data flow, work item states, available actions, and the editor panel. *(Added by [PR #28](https://github.com/mthalman/workcenter/pull/28); link will point to `docs/ux-guide.md` once merged.)*
- [Extension API](https://github.com/mthalman/workcenter/pull/29) — Provider and action contracts, interfaces, and example implementations. *(Added by [PR #29](https://github.com/mthalman/workcenter/pull/29); link will point to `docs/extension-api.md` once merged.)*

## Contributing

1. Fork the repository and create a branch from `dev`.
2. Install dependencies: `npm install`
3. Build all packages: `npm run build`
4. Run tests: `npm run test`
5. Open a pull request targeting the `dev` branch.

The default branch is **`dev`** — all work should be based from and merged back to `dev`.

## License

[MIT](LICENSE) © Matt Thalman
