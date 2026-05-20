# DevDocket

A central hub for managing work across pull requests, issues, investigations, and follow-ups.

DevDocket adds a unified work-item sidebar to VS Code. It ingests work from provider extensions such as GitHub and Azure DevOps, lets you triage what matters, and keeps your active work, backlog, paused items, and completed history in one place.

## Features

- **My Work sidebar** with five tiers for your workflow: Incoming → Ready to Start → In Progress → Paused → Done.
- **Incoming triage** for newly discovered provider items: preview, accept, start immediately, or dismiss.
- **Sources tab** that stays browsable by provider and group so you can find everything providers know about, even after triage.
- **Floating CI Watches panel** for monitoring pull request status and GitHub Actions or Azure DevOps Pipelines runs from VS Code.
- **Manual work items** for investigations and follow-ups that do not live in an external tracker.
- **Walkthrough** that introduces the DevDocket workflow, providers, active work, and CI watches.
- **Extensible provider and action model** so other extensions can add sources of work or actions you can run from a work item.

## Requirements

- VS Code 1.92.0 or later.
- Provider extensions are installed separately. Install DevDocket GitHub, DevDocket Azure DevOps, or another provider to automatically discover work from external systems.

## Getting Started

1. Install **DevDocket**.
2. Open the DevDocket activity-bar icon to see the sidebar.
3. Create a manual item with **Create Work Item**, or install a provider extension to populate the Incoming tier and Sources tab.
4. Use the **Get Started with DevDocket** walkthrough from VS Code's walkthroughs page or the **DevDocket: Open Walkthrough** command.
5. Move items through Incoming, Ready to Start, In Progress, Paused, and Done as your work changes.
6. Open the CI Watches panel from the status bar or run **DevDocket: Watch URL…** to monitor pull requests and pipeline runs.

## Configuration

DevDocket works with sensible defaults — no setup required. The full list of settings, with defaults and descriptions, is auto-generated in the **Settings** section of the **Features** tab of this Marketplace listing and is also browseable from VS Code under **Settings → Extensions → DevDocket**.

Common settings worth knowing:

- `devDocket.autoCompleteOnClose` — automatically marks linked work items Done when their issue or PR closes or merges externally.
- `devDocket.showInboxNotifications` — toggles notifications when new items arrive in the Incoming tier.
- `devDocket.watches.pollingIntervalSeconds` — how often CI Watches refreshes PR and pipeline status.

## Related

- [DevDocket GitHub](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-github) discovers GitHub issues, mentions, pull requests, review requests, and GitHub Actions status.
- [DevDocket Azure DevOps](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-ado) discovers Azure DevOps work items, pull requests, reviews, and Pipelines status.
- [DevDocket Start Git Work](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-start-git-work) creates branches and worktrees from DevDocket items.
- [DevDocket AI Reviewer](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-ai-reviewer) adds AI code review and guided walkthrough actions.
- [UX guide](https://github.com/devdocket/devdocket/blob/dev/docs/ux-guide.md)
- [Extension API](https://github.com/devdocket/devdocket/blob/dev/docs/extension-api.md)
- [GitHub repository](https://github.com/devdocket/devdocket)
- [Issue tracker](https://github.com/devdocket/devdocket/issues)
