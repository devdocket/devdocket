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

No setup is required — the GitHub provider runs against the signed-in account on first launch. The full list of settings, with defaults and descriptions, is auto-generated on the **Feature Contributions** tab of this Marketplace listing and is also browseable from VS Code under **Settings → Extensions → DevDocket GitHub**.

Most users will reach for `devDocketGithub.filteredRepos` to exclude noisy repositories from discovery (gitignore-style patterns, one per line; supports wildcards, negation with `!`, and comments).

## Related

- [DevDocket](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket) is the core sidebar and work-item hub.
- [DevDocket Azure DevOps](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-ado) connects Azure DevOps work items, PRs, and Pipelines.
- [DevDocket Start Git Work](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-start-git-work) creates branches and worktrees from DevDocket items.
- [DevDocket AI Reviewer](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-ai-reviewer) adds AI code review and guided walkthrough actions.
- [Provider discovery guide](https://github.com/devdocket/devdocket/blob/dev/docs/provider-discovery.md)
- [GitHub repository](https://github.com/devdocket/devdocket)
- [Issue tracker](https://github.com/devdocket/devdocket/issues)
