# Watch CI Pipelines and PRs

Watches are fire-and-forget monitoring for CI pipelines and pull requests. DevDocket notifies you in VS Code when a GitHub Actions workflow run or an Azure DevOps pipeline run completes or fails, or when a pull request is merged or closed.

## Where Watches Live

The **CI Watches** panel is a floating webview separate from the main DevDocket sidebar. Open it by clicking the eye icon (👁) in the VS Code status bar at the bottom — it shows the current watch count and turns amber when a watched run fails.

The panel groups watches into:
- **PR Watches** — pull requests being monitored, with each PR's CI runs flattened beneath it
- **Run Watches** — standalone pipeline runs you've added directly

## Add a Watch

From inside the **CI Watches** panel, click **+ Watch URL** in the top-right and paste either a pipeline run URL or a pull request URL. DevDocket figures out which kind it is and starts monitoring.

You can also use the Command Palette:

[Watch a Pipeline Run](command:devdocket.watchRun)

[Watch a Pull Request](command:devdocket.watchPR)

## Auto-Watching Authored PRs

GitHub PRs you authored can be auto-watched as soon as the GitHub provider discovers them. Toggle the `devDocket.watches.autoWatchAuthoredPRs` setting to control this behavior.

## Dismissing Watches

Hover any watch card in the panel and click the **✗** button to dismiss a single watch, or use **Dismiss Completed** in the panel header to clear all merged / closed PRs and finished runs in one click.
