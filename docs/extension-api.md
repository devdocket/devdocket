# WorkCenter Extension API

This document describes the WorkCenter extension API for developers building provider extensions or action plugins. Providers discover work items from external sources; actions operate on work items to automate workflows.

## Getting Started

### Extension Dependency

Your extension must declare a dependency on WorkCenter so that VS Code activates WorkCenter first:

```jsonc
// package.json
{
  "extensionDependencies": ["mthalman.workcenter"]
}
```

### Acquiring the API

In your extension's `activate()` function, acquire the `WorkCenterApi` from the core extension:

```ts
import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const coreExtension = vscode.extensions.getExtension('mthalman.workcenter');
  if (!coreExtension) {
    vscode.window.showErrorMessage('WorkCenter core extension not found. Please install and enable "mthalman.workcenter".');
    return;
  }

  let api: unknown;
  try {
    api = coreExtension.isActive
      ? coreExtension.exports
      : await coreExtension.activate();
  } catch (error) {
    console.error('Failed to activate WorkCenter core extension', error);
    vscode.window.showErrorMessage('Failed to activate WorkCenter core extension. See logs for details.');
    return;
  }

  if (
    !api ||
    typeof (api as any).registerProvider !== 'function' ||
    typeof (api as any).registerAction !== 'function'
  ) {
    console.error('WorkCenter API is not in the expected shape', api);
    vscode.window.showErrorMessage('WorkCenter API is unavailable or invalid. Please check that "mthalman.workcenter" is up to date.');
    return;
  }

  const workCenterApi = api as {
    registerProvider: (provider: unknown) => vscode.Disposable;
    registerAction: (action: unknown) => vscode.Disposable;
  };

  // workCenterApi is a WorkCenterApi instance — use it to register providers and actions
}
```

## WorkCenterApi

The API surface is intentionally small:

```ts
import * as vscode from 'vscode';

interface WorkCenterApi {
  registerProvider(provider: WorkCenterProvider): vscode.Disposable;
  registerAction(action: WorkCenterAction): vscode.Disposable;
}
```

Both methods return a `vscode.Disposable`. Push it into `context.subscriptions` so VS Code cleans up on deactivation.

## Providers

A provider discovers items from an external source (e.g., GitHub issues, Jira tickets, email) and reports them to WorkCenter.

### WorkCenterProvider Interface

```ts
import * as vscode from 'vscode';

interface WorkCenterProvider {
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
   * Called by WorkCenter during initial registration/activation (for initial
   * discovery) and whenever the user requests a manual refresh. Must be safe
   * to call multiple times and during extension activation.
   */
  refresh(): Promise<void>;
}
```

### DiscoveredItem

Each discovered item must have a unique `externalId` within the provider:

```ts
interface DiscoveredItem {
  /**
   * Unique identifier for this item within the provider.
   * Must be stable across refreshes (e.g., 'owner/repo#123').
   * WorkCenter uses providerId + externalId to track inbox state.
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
}
```

**Conventions:**

- `externalId` must be unique per provider and stable across refreshes. A good pattern is `owner/repo#123`.
- Each `onDidDiscoverItems` emission replaces the provider's entire item set. Emit all current items, not just changes.
- `DiscoveredItem` data is not stored as a persisted record; WorkCenter tracks only the inbox state (`unseen`, `accepted`, `dismissed`) for discovered items in `discovered-state.json`.
- When a user accepts an item from Inbox/Sources, WorkCenter creates and persists a new `WorkItem` in `workitems.json` that includes a snapshot of the item's `title`, along with its `providerId`/`externalId`/`url` as provenance metadata.
- Use `group` to organize items in the Sources tree. Items with the same group value are nested under a folder.

### Registering a Provider

```ts
const provider = new MyProvider();
const disposable = api.registerProvider(provider);
context.subscriptions.push(disposable);
```

## Actions

An action is an operation that can be performed on a work item. Actions are surfaced dynamically in the **Run Action…** quick pick menu on Queue and Focus items.

### WorkCenterAction Interface

```ts
interface WorkCenterAction {
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

> **Note:** `canRun` and `run` receive `Readonly<WorkItem>`. Actions should treat work items as immutable and use WorkCenter commands to make changes rather than mutating the object directly.

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
  /** Internal unique ID generated by WorkCenter (e.g., 'wc-m3x9k2-a7b3c1'). */
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
   * Optional ordering hint used by WorkCenter to sort items in the Queue view.
   * Typically managed by WorkCenter; extensions generally do not need to set this.
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

`canRun()` and `run()` receive `Readonly<WorkItem>`. Actions must not mutate the work item object directly. To update a work item's state, use the appropriate WorkCenter VS Code commands (e.g., `workcenter.startWork`, `workcenter.completeWork`).

### URL Validation

URLs opened via `vscode.env.openExternal` are validated to use `http:` or `https:` schemes only. Other URL schemes (e.g., `file:`, `javascript:`, custom protocols) are rejected. Ensure any URLs your provider or action constructs use standard web URLs.

## Examples

### Minimal Provider

This example shows a provider that discovers items from a hypothetical task API.

> **Note:** The `activate()` function below omits the full validation and error handling shown in [Acquiring the API](#acquiring-the-api) for brevity. Production extensions should use the robust pattern from that section.

```ts
import * as vscode from 'vscode';

interface DiscoveredItem {
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  group?: string;
}

interface Disposable {
  dispose(): void;
}

interface Event<T> {
  (listener: (e: T) => void): Disposable;
}

interface WorkCenterProvider {
  readonly id: string;
  readonly label: string;
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;
  refresh(): Promise<void>;
}

class MyTaskProvider implements WorkCenterProvider {
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
  const coreExtension = vscode.extensions.getExtension('mthalman.workcenter');
  if (!coreExtension) {
    return;
  }

  const api = coreExtension.isActive
    ? coreExtension.exports
    : await coreExtension.activate();

  const provider = new MyTaskProvider();
  const registration = api.registerProvider(provider);

  // Provider owns its own disposal — WorkCenter does not call provider.dispose().
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

enum WorkItemState {
  New = 'New',
  InProgress = 'InProgress',
  Paused = 'Paused',
  Done = 'Done',
  Archived = 'Archived',
}

interface WorkItem {
  id: string;
  title: string;
  notes?: string;
  state: WorkItemState;
  providerId?: string;
  externalId?: string;
  url?: string;
  sortOrder?: number;
  createdAt: number;
  updatedAt: number;
}

interface WorkCenterAction {
  readonly id: string;
  readonly label: string;
  canRun(item: Readonly<WorkItem>): boolean;
  run(item: Readonly<WorkItem>): Promise<void>;
}

class OpenDashboardAction implements WorkCenterAction {
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

For a complete, production-quality example, see the `packages/github` package in the WorkCenter repository:

- [`githubProvider.ts`](../packages/github/src/githubProvider.ts) — Full provider with periodic refresh, GitHub API integration, and error handling.
- [`githubPrReviewProvider.ts`](../packages/github/src/githubPrReviewProvider.ts) — Provider for PR review requests.
- [`startWorkAction.ts`](../packages/start-git-work/src/startWorkAction.ts) — Action that creates a git branch and worktree for GitHub and ADO work items.
- [`extension.ts`](../packages/github/src/extension.ts) — Full activation flow showing API acquisition and registration.
