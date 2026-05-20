# DevDocket AI Reviewer

AI-powered code review and PR walkthrough actions for DevDocket

DevDocket AI Reviewer adds two AI-assisted workflows to DevDocket: code review over GitHub pull request diffs, and an `@walkthrough` chat participant for guided codebase tours. It uses VS Code's Language Model API and Copilot Chat so the experience stays inside VS Code.

## Features

- Run **AI Code Review** from a DevDocket GitHub pull request work item to analyze the PR diff with a VS Code language model.
- Customize the review instructions with your own prompt file while DevDocket appends the PR diff automatically.
- Use the sticky `@walkthrough` chat participant for guided codebase tours and PR walkthroughs.
- Expose language-model tools for advanced AI workflows: Read File, List Directory, Get PR Diff, Get File Diff, Git Log, Search Code, and Diff Anchor Hash.
- Keep review and walkthrough context tied to the DevDocket work item you are already using.

## Requirements

- VS Code 1.96.0 or later.
- DevDocket core (`devdocket.devdocket`) must be installed. VS Code installs it automatically through this extension's `extensionDependencies`.
- GitHub pull request work items are required for AI Code Review.
- Copilot Chat and access to VS Code's Language Model API are required for AI review and walkthrough experiences.

## Getting Started

1. Install **DevDocket AI Reviewer**. VS Code will also install **DevDocket** if it is not already present.
2. Install and configure **DevDocket GitHub** so pull request work items appear in the DevDocket sidebar.
3. Make sure Copilot Chat is installed and you are signed in with access to language models.
4. Open a GitHub pull request work item in DevDocket.
5. Choose **Run Action…** → **AI Code Review** to review the pull request diff, or start a chat with `@walkthrough` for a guided codebase tour.

## Configuration

No setup is required — the AI Code Review action and `@walkthrough` chat participant work out of the box. The full list of settings is auto-documented on the **Feature Contributions** tab of this Marketplace listing and is also browseable from VS Code under **Settings → Extensions → DevDocket AI Reviewer**.

Set `devDocketAiReview.customPromptPath` if you want to replace the built-in review instructions with your own prompt file. The PR diff is appended automatically.

## Related

- [DevDocket](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket) is the core sidebar and work-item hub.
- [DevDocket GitHub](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-github) connects GitHub issues, PRs, and Actions.
- [DevDocket Azure DevOps](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-ado) connects Azure DevOps work items, PRs, and Pipelines.
- [DevDocket Start Git Work](https://marketplace.visualstudio.com/items?itemName=devdocket.devdocket-start-git-work) creates branches and worktrees from DevDocket items.
- [UX guide](https://github.com/devdocket/devdocket/blob/dev/docs/ux-guide.md)
- [GitHub repository](https://github.com/devdocket/devdocket)
- [Issue tracker](https://github.com/devdocket/devdocket/issues)
