# DevDocket Extension API

This document describes the DevDocket extension API for developers building provider extensions or action plugins. Providers discover work items from external sources; actions operate on work items to automate workflows.

## Getting Started

### Extension Dependency

Your extension must declare a dependency on DevDocket so that VS Code activates DevDocket first:

```jsonc
// package.json
{
  "extensionDependencies": ["mthalman.devdocket"]
}
```

### Installing `@devdocket/shared`

The `@devdocket/shared` package provides the TypeScript types and base classes (`DiscoveredItem`, `BaseProvider`, `Event`, `Disposable`, etc.) needed to build providers and actions with full type safety.

The package is published to the GitHub Packages npm registry. Add a `.npmrc` file to your project to configure the `@devdocket` scope:

```ini
@devdocket:registry=https://npm.pkg.github.com
```

Then install the package:

```bash
npm install @devdocket/shared
```

> **Note:** GitHub Packages requires authentication. See [GitHub's docs on authenticating to GitHub Packages](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages) for setup instructions.

You can then import types directly instead of redefining them:

```ts
import { BaseProvider, type DiscoveredItem } from '@devdocket/shared';
```

### Acquiring the API

In your extension's `activate()` function, acquire the `DevDocketApi` from the core extension:

```ts
import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const coreExtension = vscode.extensions.getExtension('mthalman.devdocket');
  if (!coreExtension) {
    vscode.window.showErrorMessage('DevDocket core extension not found. Please install and enable "mthalman.devdocket".');
    return;
  }

  let api: unknown;
  try {
    api = coreExtension.isActive
      ? coreExtension.exports
      : await coreExtension.activate();
  } catch (error) {
    console.error('Failed to activate DevDocket core extension', error);
    vscode.window.showErrorMessage('Failed to activate DevDocket core extension. See logs for details.');
    return;
  }

  if (
    !api ||
    typeof (api as any).registerProvider !== 'function' ||
    typeof (api as any).registerAction !== 'function'
  ) {
    console.error('DevDocket API is not in the expected shape', api);
    vscode.window.showErrorMessage('DevDocket API is unavailable or invalid. Please check that "mthalman.devdocket" is up to date.');
    return;
  }

  const devDocketApi = api as {
    registerProvider: (provider: unknown) => vscode.Disposable;
    registerAction: (action: unknown) => vscode.Disposable;
  };

  // devDocketApi is a DevDocketApi instance — use it to register providers and actions
}
```

## DevDocketApi

The API surface is intentionally small:

```ts
import * as vscode from 'vscode';

interface DevDocketApi {
  registerProvider(provider: DevDocketProvider): vscode.Disposable;
  registerAction(action: DevDocketAction): vscode.Disposable;
}
```

Both methods return a `vscode.Disposable`. Push it into `context.subscriptions` so VS Code cleans up on deactivation.

## Providers

A provider discovers items from an external source (e.g., GitHub issues, Jira tickets, email) and reports them to DevDocket.

### DevDocketProvider Interface

```ts
import * as vscode from 'vscode';

interface DevDocketProvider {
  /** Unique identifier for this provider (e.g., 'github', 'jira'). */
  readonly id: string;

  /** Human-readable label shown in the UI (e.g., 'GitHub Issues'). */
  readonly label: string;

  /**
   * Event that fires when the provider has new items to report.
   * Each emission replaces the provider's entire item set.
   */
  readonly onDidDiscoverItems: vscode.Event<DiscoveredItem[]>;

  /**
   * Called by DevDocket during initial registration/activation (for initial
   * discovery) and whenever the user requests a manual refresh. Must be safe
   * to call multiple times and during extension activation.
   */
  refresh(token?: vscode.CancellationToken): Promise<void>;

  /**
   * Check which of the given external items have been closed or completed.
   * Called after each provider refresh to auto-complete linked work items,
   * including manually-imported items. Return the subset of externalIds
   * that are closed, merged, or completed.
   * Optional — providers without this fall back to disappearance detection.
   */
  getClosedItems?(externalIds: string[], signal?: AbortSignal): Promise<string[]>;
}
```

### DiscoveredItem

Each discovered item must have a unique `externalId` within the provider:

```ts
interface DiscoveredItem {
  /**
   * Unique identifier for this item within the provider.
   * Must be stable across refreshes (e.g., 'owner/repo#123').
   * DevDocket uses providerId + externalId to track inbox state.
   */
  externalId: string;

  /** Title displayed in the Inbox and Sources views. */
  title: string;

  /** Optional description shown in tooltips (can be long). */
  description?: string;

  /** Optional URL for "Open in Browser" support. */
  url?: string;

  /**
   * Optional group name for sub-grouping in the Sources view.
   * Items with the same group appear under a folder node.
   * For example, a GitHub provider might group by repository name.
   */
  group?: string;

  /**
   * Optional cross-provider deduplication key.
   * Items from different providers that share the same canonicalId are
   * grouped in the Inbox (one representative shown). Accept/dismiss/read-state
   * propagates to all items in the group.
   * Items without canonicalId always show individually (backward compatible).
   * Use a consistent format like 'github:pull:owner/repo#42'.
   */
  canonicalId?: string;
}
```

**Conventions:**

- `externalId` must be unique per provider and stable across refreshes. A good pattern is `owner/repo#123`.
- Each `onDidDiscoverItems` emission replaces the provider's entire item set. Emit all current items, not just changes.
- `DiscoveredItem` data is not stored as a persisted record; DevDocket tracks only the inbox state (`unseen`, `accepted`, `dismissed`) for discovered items in `discovered-state.json`.
- When a user accepts an item from Inbox/Sources, DevDocket creates and persists a new `WorkItem` in `workitems.json` that includes a snapshot of the item's `title`, along with its `providerId`/`externalId`/`url` as provenance metadata.
- Use `group` to organize items in the Sources tree. Items with the same group value are nested under a folder.
- Use `canonicalId` when the same entity might be discovered by multiple providers (e.g., a PR found by both "My PRs" and "PR Reviews"). Items sharing a `canonicalId` are deduplicated in the Inbox — one representative is shown and accept/dismiss propagates to all. Use a consistent format like `github:pull:owner/repo#42`. Items without `canonicalId` show individually (backward compatible). The Sources view is unaffected.

### Registering a Provider

```ts
const provider = new MyProvider();
const disposable = api.registerProvider(provider);
context.subscriptions.push(disposable);
```

## Actions

An action is an operation that can be performed on a work item. Actions are surfaced dynamically in the **Run Action…** quick pick menu on Queue and Focus items.

### DevDocketAction Interface

```ts
interface DevDocketAction {
  /** Unique identifier for this action (e.g., 'github.startWork'). */
  readonly id: string;

  /** Human-readable label shown in the quick pick (e.g., 'Start Work (Branch + Worktree)'). */
  readonly label: string;

  /**
   * Returns true if this action can run on the given item.
   * Called each time the user opens the Run Action menu.
   * Use this to filter by provider, state, or other item properties.
   */
  canRun(item: Readonly<WorkItem>): boolean;

  /**
   * Executes the action. Throw an error to show an error message to the user.
   */
  run(item: Readonly<WorkItem>): Promise<void>;
}
```

> **Note:** `canRun` and `run` receive `Readonly<WorkItem>`. Actions should treat work items as immutable and use DevDocket commands to make changes rather than mutating the object directly.

### Registering an Action

```ts
const action = new MyAction();
const disposable = api.registerAction(action);
context.subscriptions.push(disposable);
```

## WorkItem Model

When an action receives a `WorkItem`, it has access to these fields:

```ts
interface WorkItem {
  /** Internal unique ID generated by DevDocket (e.g., 'wc-m3x9k2-a7b3c1'). */
  id: string;

  /** User-visible title. */
  title: string;

  /** Optional user-added notes. */
  notes?: string;

  /** Current state in the lifecycle. */
  state: WorkItemState;

  /** Provider ID if this item originated from a provider. */
  providerId?: string;

  /** External ID from the provider (e.g., 'owner/repo#123'). */
  externalId?: string;

  /** URL associated with the item (e.g., GitHub issue URL). */
  url?: string;

  /**
   * Optional ordering hint used by DevDocket to sort items in the Queue view.
   * Typically managed by DevDocket; extensions generally do not need to set this.
   */
  sortOrder?: number;

  /** Timestamp (ms since epoch) when the item was created. */
  createdAt: number;

  /** Timestamp (ms since epoch) when the item was last updated. */
  updatedAt: number;
}
```

### WorkItemState

```ts
enum WorkItemState {
  New = 'New',
  InProgress = 'InProgress',
  Paused = 'Paused',
  Done = 'Done',
  Archived = 'Archived',
}
```

Items transition through these states as the user interacts with them in the UI.

**State visibility in the UI:**

| State | View | Description |
|-------|------|-------------|
| `New` | **Queue** | Freshly created or accepted items awaiting triage. |
| `InProgress` | **Focus** | Work the user is actively doing. |
| `Paused` | **Focus** | Work that is temporarily paused (shown alongside in-progress items). |
| `Done` | **History** | Completed items shown in the History view. |
| `Archived` | **History** | Archived items shown in the History view. |

Action authors should use this mapping when implementing `canRun()` — for example, an action that only applies to active work should target `InProgress` and `Paused`.

## Limits and Security

### Item Count Limits

Each provider is capped at **10,000 discovered items** per refresh. If a provider emits more than 10,000 items, excess items are silently truncated from the end and a warning is logged. Design your provider to stay within this limit — for example, by filtering to only relevant items in your `refresh()` implementation.

### Readonly WorkItem in Actions

`canRun()` and `run()` receive `Readonly<WorkItem>`. Actions must not mutate the work item object directly. To update a work item's state, use the appropriate DevDocket VS Code commands (e.g., `devdocket.acceptToFocus`, `devdocket.completeItem`).

### URL Validation

URLs opened via `vscode.env.openExternal` are validated to use `http:` or `https:` schemes only. Other URL schemes (e.g., `file:`, `javascript:`, custom protocols) are rejected. Ensure any URLs your provider or action constructs use standard web URLs.

## Auto-Completion

DevDocket can automatically mark work items as **Done** when their linked external item is closed or merged. This is controlled by the `devdocket.autoCompleteOnClose` setting (default: `true`).

After each provider refresh, DevDocket scans the WorkGraph for items linked to that provider in auto-completable states (`New`, `InProgress`, `Paused`). It then checks whether those external items are closed:

1. **If the provider implements `getClosedItems()`** — DevDocket calls it with the full set of linked external IDs (deduplicated). This covers both provider-discovered items and manually-imported items (e.g., items created via "Create Item from URL"). Return the subset of IDs that are closed, merged, or completed.

2. **Fallback: disappearance detection** — For providers without `getClosedItems()`, DevDocket compares the current discovered items against the previous refresh. Items that were previously present but are now absent are assumed closed. This fallback *cannot* cover manually-imported items since the provider never discovered them.

Matched items are transitioned to `Done` and a notification is shown with a "Show History" action.

### Implementing `getClosedItems()`

```ts
async getClosedItems(externalIds: string[], signal?: AbortSignal): Promise<string[]> {
  // Batch-check external IDs against your source system's API
  // Return only the ones that are closed, merged, or completed
  const statuses = await this.fetchStatuses(externalIds, signal);
  return statuses
    .filter(s => s.isClosed)
    .map(s => s.externalId);
}
```

**Guidelines:**
- Batch API calls where possible — avoid one network call per item.
- Handle auth failures gracefully — log and return an empty array rather than throwing.
- Respect the `AbortSignal` — check `signal?.aborted` between API calls and pass `signal` to `fetch()`.
- Use silent/non-interactive auth — `getClosedItems()` runs after background refreshes and should never prompt the user.

## Examples

### Minimal Provider

This example shows a provider that discovers items from a hypothetical task API.

> **Note:** The `activate()` function below omits the full validation and error handling shown in [Acquiring the API](#acquiring-the-api) for brevity. Production extensions should use the robust pattern from that section.

```ts
import * as vscode from 'vscode';
import type { DiscoveredItem, DevDocketProvider } from '@devdocket/shared';

class MyTaskProvider implements DevDocketProvider {
  readonly id = 'my-tasks';
  readonly label = 'My Tasks';

  private readonly _onDidDiscoverItems = new vscode.EventEmitter<DiscoveredItem[]>();
  readonly onDidDiscoverItems = this._onDidDiscoverItems.event;

  async refresh(): Promise<void> {
    // Fetch tasks from your external source
    const tasks = await this.fetchTasks();

    const items: DiscoveredItem[] = tasks.map((task) => ({
      externalId: `task-${task.id}`,
      title: task.title,
      description: task.summary,
      url: `https://tasks.example.com/${task.id}`,
      group: task.project,
    }));

    // Emit the full set of items — this replaces any previous emission
    this._onDidDiscoverItems.fire(items);
  }

  private async fetchTasks(): Promise<Array<{ id: string; title: string; summary: string; project: string }>> {
    // Replace with your actual data fetching logic
    return [];
  }

  dispose(): void {
    this._onDidDiscoverItems.dispose();
  }
}

// In your activate() function:
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const coreExtension = vscode.extensions.getExtension('mthalman.devdocket');
  if (!coreExtension) {
    return;
  }

  const api = coreExtension.isActive
    ? coreExtension.exports
    : await coreExtension.activate();

  const provider = new MyTaskProvider();
  const registration = api.registerProvider(provider);

  // Provider owns its own disposal — DevDocket does not call provider.dispose().
  // Push both the registration and provider into subscriptions for cleanup.
  context.subscriptions.push(registration);
  context.subscriptions.push({ dispose: () => provider.dispose() });

  // No need to call provider.refresh() manually — registerProvider() triggers
  // initial discovery automatically.
}
```

### Minimal Action

This example shows an action that opens a dashboard page for a work item using its external ID:

```ts
import * as vscode from 'vscode';
import { WorkItemState, type WorkItem, type DevDocketAction } from '@devdocket/shared';

class OpenDashboardAction implements DevDocketAction {
  readonly id = 'my-tasks.openDashboard';
  readonly label = 'Open in Dashboard';

  canRun(item: Readonly<WorkItem>): boolean {
    // Only show this action for items from our provider
    return item.providerId === 'my-tasks';
  }

  async run(item: Readonly<WorkItem>): Promise<void> {
    if (!item.externalId) {
      vscode.window.showErrorMessage('No external ID found for this item.');
      return;
    }

    const dashboardUrl = `https://tasks.example.com/dashboard/${item.externalId}`;
    await vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
  }
}

// In your activate() function, after acquiring the API:
const action = new OpenDashboardAction();
context.subscriptions.push(api.registerAction(action));
```

## Real-World Reference

For a complete, production-quality example, see the `packages/github` package in the DevDocket repository:

- [`githubProvider.ts`](../packages/github/src/githubProvider.ts) — Full provider with periodic refresh, GitHub API integration, and error handling.
- [`githubPrReviewProvider.ts`](../packages/github/src/githubPrReviewProvider.ts) — Provider for PR review requests.
- [`startWorkAction.ts`](../packages/start-git-work/src/startWorkAction.ts) — Action that creates a git branch and worktree for GitHub and ADO work items.
- [`extension.ts`](../packages/github/src/extension.ts) — Full activation flow showing API acquisition and registration.
