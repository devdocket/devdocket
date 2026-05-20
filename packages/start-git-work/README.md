# DevDocket Start Git Work

Start Git Work action for DevDocket — creates git branches and worktrees for GitHub and Azure DevOps work items.

DevDocket Start Git Work turns an accepted issue or pull request into a local development workspace. From a DevDocket work item, run one action to create a branch, optionally create a sibling git worktree, and launch any follow-up commands you use to start coding.

## Features

- Add a **Start Git Work** action to eligible GitHub and Azure DevOps work items in DevDocket.
- Create a feature branch for issue work or a local branch for pull request work.
- Create a git worktree so each item can have its own working directory.
- Prompt for repository path, base branch, branch name, and worktree path with useful defaults.
- Optionally run post-worktree commands, such as opening the new worktree in VS Code or another terminal.

## Requirements

- VS Code 1.92.0 or later.
- DevDocket core (`devdocket.devdocket`) must be installed. VS Code installs it automatically through this extension's `extensionDependencies`.
- Git must be installed and available on your PATH.
- A DevDocket provider, such as DevDocket GitHub or DevDocket Azure DevOps, is required for provider-linked issues and pull requests.

## Getting Started

1. Install **DevDocket Start Git Work**. VS Code will also install **DevDocket** if it is not already present.
2. Install and configure a provider extension such as **DevDocket GitHub** or **DevDocket Azure DevOps**.
3. Accept or start an issue or pull request in the DevDocket sidebar.
4. Open the work item and choose **Run Action…** → **Start Git Work**.
5. Confirm the prompts for repository, branch, and worktree path.
6. Start coding in the branch or worktree created for that item.

## Configuration

The Start Git Work action runs with sensible defaults — no setup required. The full list of settings is auto-documented in the **Settings** section of the **Features** tab of this Marketplace listing and is also browseable from VS Code under **Settings → Extensions → DevDocket Start Git Work**.

The most useful setting is `devDocketStartGitWork.commands`, which lets you run follow-up commands after the worktree is created — for example, opening the new worktree in a fresh VS Code window:

```jsonc
{
  "devDocketStartGitWork.commands": [
    { "command": "code.cmd", "args": ["{path}"] }
  ]
}
```

`{path}` is replaced with the absolute path of the new worktree. On Windows, use the explicit `.cmd` extension for batch-file executables such as `code.cmd`.

## Related

- [DevDocket](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket) is the core sidebar and work-item hub.
- [DevDocket GitHub](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-github) connects GitHub issues, PRs, and Actions.
- [DevDocket Azure DevOps](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-ado) connects Azure DevOps work items, PRs, and Pipelines.
- [DevDocket AI Reviewer](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-ai-reviewer) adds AI code review and guided walkthrough actions.
- [UX guide](https://github.com/devdocket/devdocket/blob/dev/docs/ux-guide.md)
- [GitHub repository](https://github.com/devdocket/devdocket)
- [Issue tracker](https://github.com/devdocket/devdocket/issues)
