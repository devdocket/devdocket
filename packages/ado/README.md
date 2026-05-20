# DevDocket Azure DevOps

Azure DevOps provider for DevDocket — discovers assigned work items and PR reviews.

DevDocket Azure DevOps connects Azure DevOps to the DevDocket sidebar. It surfaces assigned work items, pull request reviews, and authored pull requests, then keeps Azure DevOps Pipelines and pull request status visible from VS Code.

## Features

- Discover active Azure DevOps work items assigned to you.
- Discover active pull requests where you are a reviewer, including direct reviewer assignments and group/team reviewer assignments when Azure DevOps permissions allow membership lookup.
- Discover active pull requests you authored, with vote-derived status badges such as approved, rejected, waiting for author, and draft.
- Resurface accepted PR review items when new iterations are pushed.
- Watch Azure DevOps pull request lifecycle status and Pipelines runs in DevDocket's CI Watches panel.
- Use VS Code's built-in Microsoft authentication for Azure DevOps access.

## Requirements

- VS Code 1.92.0 or later.
- DevDocket core (`devdocket.devdocket`) must be installed. VS Code installs it automatically through this extension's `extensionDependencies`.
- Access to at least one Azure DevOps organization or project.
- `devDocketAdo.projects` must be configured before this provider can discover work.

## Getting Started

1. Install **DevDocket Azure DevOps**. VS Code will also install **DevDocket** if it is not already present.
2. Sign in to your Microsoft account when VS Code prompts you.
3. Add one or more organizations or projects to `devDocketAdo.projects`.
4. Open the DevDocket sidebar.
5. Wait for the Azure DevOps provider to refresh, or run **DevDocket: Refresh**.
6. Triage discovered work from the Incoming tier, browse all discovered Azure DevOps items from Sources, and monitor pull requests in the CI Watches panel.

## Configuration

This extension requires one setting before it can discover work:

```jsonc
{
  "devDocketAdo.projects": [
    "contoso",
    "fabrikam/web-platform"
  ]
}
```

Each entry is either `<org>` to monitor an entire Azure DevOps organization or `<org>/<project>` to scope to a single project. Multiple entries are supported.

The remaining settings (refresh interval, PR review resurfacing, etc.) are auto-documented in the **Settings** section of the **Features** tab of this Marketplace listing and are also browseable from VS Code under **Settings → Extensions → DevDocket Azure DevOps**.

## Related

- [DevDocket](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket) is the core sidebar and work-item hub.
- [DevDocket GitHub](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-github) connects GitHub issues, PRs, and Actions.
- [DevDocket Start Git Work](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-start-git-work) creates branches and worktrees from DevDocket items.
- [DevDocket AI Reviewer](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-ai-reviewer) adds AI code review and guided walkthrough actions.
- [Provider discovery guide](https://github.com/devdocket/devdocket/blob/dev/docs/provider-discovery.md)
- [GitHub repository](https://github.com/devdocket/devdocket)
- [Issue tracker](https://github.com/devdocket/devdocket/issues)
