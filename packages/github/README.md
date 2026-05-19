# DevDocket GitHub

GitHub provider for DevDocket — discovers assigned issues, PR reviews, and authored PRs with status tracking.

DevDocket GitHub connects GitHub to the DevDocket sidebar. It surfaces the GitHub issues, mentions, review requests, and pull requests that need your attention, then keeps pull request and GitHub Actions status visible from VS Code.

## Features

- Discover open GitHub issues assigned to you.
- Discover issues and pull requests where you are mentioned.
- Discover open pull requests where your review has been requested.
- Discover open pull requests you authored or are assigned to, with status badges such as draft, approved, changes requested, and ready to merge.
- Resurface accepted PR review items when new commits are pushed or review is explicitly re-requested.
- Watch GitHub pull request lifecycle status and GitHub Actions runs in DevDocket's CI Watches panel.
- Use VS Code's built-in GitHub authentication; no personal access token setup is required.

## Requirements

- VS Code 1.92.0 or later.
- DevDocket core (`devdocket.devdocket`) must be installed. VS Code installs it automatically through this extension's `extensionDependencies`.
- A GitHub account signed in through VS Code's built-in GitHub authentication.

## Getting Started

1. Install **DevDocket GitHub**. VS Code will also install **DevDocket** if it is not already present.
2. Sign in to GitHub when VS Code prompts you, or use VS Code's **Accounts** menu to sign in first.
3. Open the DevDocket sidebar.
4. Wait for the GitHub provider to refresh, or run **DevDocket: Refresh**.
5. Triage discovered work from the Incoming tier, browse all discovered GitHub items from Sources, and monitor pull requests in the CI Watches panel.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `devDocketGithub.filteredRepos` | `""` | Newline-separated repository patterns to exclude from discovery, matched against `owner/repo`. Supports wildcards, comments, and `!` re-include entries. Leave empty to include all repositories you can access. |
| `devDocketGithub.refreshIntervalSeconds` | `300` | How often to refresh GitHub data, in seconds. Values below 60 are clamped. |
| `devDocketGithub.resurfaceOnNewVersion` | `true` | Resurface accepted PR review items when new commits are pushed. |
| `devDocketGithub.resurfaceOnReRequestedReview` | `true` | Resurface accepted PR review items when review is explicitly re-requested. |

## Related

- [DevDocket](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket) is the core sidebar and work-item hub.
- [DevDocket — Azure DevOps](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-ado) connects Azure DevOps work items, PRs, and Pipelines.
- [DevDocket Start Git Work](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-start-git-work) creates branches and worktrees from DevDocket items.
- [DevDocket — AI Actions](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-ai-reviewer) adds AI code review and guided walkthrough actions.
- [Provider discovery guide](https://github.com/devdocket/devdocket/blob/dev/docs/provider-discovery.md)
- [GitHub repository](https://github.com/devdocket/devdocket)
- [Issue tracker](https://github.com/devdocket/devdocket/issues)
