# DevDocket

<p align="center">
  <img src="branding/logo.svg" alt="DevDocket Logo" width="64" height="64" />
</p>

**A unified work hub inside VS Code.**

DevDocket is a VS Code extension that brings all of your work items — GitHub issues, Azure DevOps work items, PR review requests, and ad-hoc tasks — into a single, organized sidebar. Instead of juggling browser tabs, notification emails, and sticky notes, you manage everything from where you already write code.

## Why DevDocket?

Developers constantly context-switch between tools. Issues live in GitHub, tasks live in Azure DevOps, review requests arrive by email, and ad-hoc follow-ups exist only in your head. DevDocket is **not** a replacement for any of these — it's an **aggregation layer** that gives you a personal, unified view of your work inside VS Code.

- **Providers** discover items from external sources (GitHub, Azure DevOps, and more) and surface them automatically.
- **You** decide what to accept, what to dismiss, and what to work on next.
- **Actions** automate workflows — like creating a branch and worktree for a work item with one click.

## Workflow

DevDocket organizes your work in a single sidebar view with two tabs:

- **My Work** — your active workflow, organized into tiers (in render order):

  | Tier | Purpose |
  |------|---------|
  | **↓ Incoming** | Newly discovered items from providers. Click to preview, then **Accept** or **Dismiss**. |
  | **▶ In Progress** | What you're actively working on. Pause or complete from hover actions. |
  | **○ Ready to Start** | Your curated backlog — accepted items and manual tasks. |
  | **⏸ Paused** | Items temporarily set aside. Resume to bring them back into In Progress. |
  | **✓ Done** | Completed items — your work record. |

- **Sources** — everything providers know about, grouped by provider, browsable anytime.

A separate floating **CI Watches** panel monitors GitHub Actions / Azure DevOps Pipeline runs and pull request lifecycle status (open / merged / closed). Open it from the eye icon in the status bar.

By default, provider-linked items are automatically marked **Done** when their issue is closed or their PR is merged externally.

For detailed view behavior, keyboard shortcuts, and configuration options, see the [UX Guide](docs/ux-guide.md).

## Installation

DevDocket's core, provider, and git-worktree extensions require VS Code 1.92.0 or later. The AI reviewer extension requires VS Code 1.96.0 or later.

DevDocket is not yet available on the VS Code Marketplace. To run it, build from source:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/devdocket/devdocket.git
   cd devdocket
   ```

2. **Install dependencies and build:**
   ```bash
   npm install
   npm run build
   ```

3. **Run in VS Code** — open the repo in VS Code and press **F5** to launch the Extension Development Host with DevDocket loaded.

4. **Package for local install** (optional):
   ```bash
   cd packages/core
   npx @vscode/vsce package
   ```
   Run this from each extension folder you want to package (e.g., `packages/core`, `packages/github`). This produces a `.vsix` file you can install via **Extensions → ⋯ → Install from VSIX…** in VS Code.

5. **Regenerate the status-bar icon font** (only when the logomark changes):
   ```bash
   npm run build:icons -w devdocket
   ```
   This converts `packages/core/resources/devdocket-logo-mono.svg` into the checked-in `packages/core/resources/devdocket-icons.woff` glyph used by VS Code status bar icons.

## Plugin Ecosystem

DevDocket is extensible with two types of plugins:

| Type | Description |
|------|-------------|
| **Providers** | Discover work items from external sources and surface them in DevDocket. |
| **Actions** | Operations that run on a work item (e.g., create a branch, run AI code review). |

**Included extensions:**

| Extension | Type | What It Does |
|-----------|------|--------------|
| DevDocket GitHub | Provider + Watcher | Discovers GitHub issues, mentions, PR review requests, and pull requests you authored or are assigned to; watches GitHub Actions runs and PR status |
| DevDocket — Azure DevOps | Provider + Watcher | Discovers Azure DevOps work items, PR review requests, and authored PRs; watches ADO Pipelines and PR status |
| DevDocket Start Git Work | Action | Creates a feature branch and a sibling git worktree for a work item, optionally running follow-up commands |
| DevDocket — AI Actions | Action | AI-powered code review against GitHub and Azure DevOps PR diffs plus a `@walkthrough` chat participant for guided codebase tours |

To build your own provider or action, see the [Extension API documentation](docs/extension-api.md).

## Architecture

DevDocket is a monorepo with five VS Code extensions and a shared library:

```
packages/
├── core/              # The hub extension (UI, lifecycle, plugin API)
├── github/            # GitHub issues, mentions, PR reviews, my-PRs + Actions and PR watcher
├── ado/               # Azure DevOps work items, PR reviews, my-PRs + Pipelines and PR watcher
├── start-git-work/    # Branch + worktree action
├── ai-reviewer/       # AI code review action
└── shared/            # Shared library (BaseProvider, utilities)
```

## Documentation

| Document | Description |
|----------|-------------|
| [UX Guide](docs/ux-guide.md) | Views, data flow, configuration, keyboard shortcuts |
| [Extension API](docs/extension-api.md) | Provider and action contracts, interfaces, examples |
| [Provider Discovery](docs/provider-discovery.md) | What causes items to appear in each provider |

## Contributing

1. Fork the repository and create a branch from `dev`.
2. Install dependencies: `npm install`
3. Build all packages: `npm run build`
4. Run tests: `npm run test`
5. Open a pull request targeting the `dev` branch.

The default branch is **`dev`** — all work should be based from and merged back to `dev`.

## License

[MIT](LICENSE) © Matt Thalman
