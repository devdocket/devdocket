# WorkCenter Provider API Guide

WorkCenter is a VS Code extension that acts as a central hub for managing work items from multiple sources. Third-party extensions integrate with WorkCenter by registering **providers** (to discover items from external systems) and **actions** (to add capabilities that operate on work items).

This guide walks through the API surface and shows how to build a provider extension from scratch.

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Implementing a Provider](#implementing-a-provider)
- [Implementing an Action](#implementing-an-action)
- [Data Flow](#data-flow)
- [Best Practices](#best-practices)
- [API Reference](#api-reference)

---

## Overview

WorkCenter organizes work items through a lifecycle of views:

| View | Purpose |
|------|---------|
| **Inbox** | Newly discovered provider items the user hasn't seen yet |
| **Queue** | The user's curated backlog of accepted items |
| **Focus** | Items the user is actively working on |
| **History** | Completed and archived items |
| **Sources** | A browsable library of everything providers know about |

**Providers** feed items into this system by emitting `DiscoveredItem` arrays. For discovery views such as **Inbox** and **Sources**, item data is read live from the provider. When a user accepts an item, WorkCenter stores a snapshot of it as a `WorkItem`, and **Queue**, **Focus**, and **History** render that persisted data instead of always reading live from the provider.

**Actions** extend what users can do with work items. The context menu exposes a single `Run Action…` command, and the available actions shown in that quick pick are filtered per-item via a `canRun()` predicate.

---

## Getting Started

### 1. Declare the Extension Dependency

Add WorkCenter as an extension dependency in your `package.json` so VS Code activates it before your extension:

```jsonc
// package.json
{
  "extensionDependencies": ["mthalman.workcenter"]
}
```

### 2. Acquire the API

In your extension's `activate()` function, get the `WorkCenterApi` from the core extension:

```ts
import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const coreExtension = vscode.extensions.getExtension('mthalman.workcenter');
  if (!coreExtension) {
    vscode.window.showErrorMessage(
      'WorkCenter core extension not found. Install "mthalman.workcenter".'
    );
    return;
  }

  let api: unknown;
  try {
    api = coreExtension.isActive
      ? coreExtension.exports
      : await coreExtension.activate();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(
      `Failed to activate WorkCenter: ${message}`
    );
    return;
  }

  if (
    !api ||
    typeof api.registerProvider !== 'function' ||
    typeof api.registerAction !== 'function'
  ) {
    vscode.window.showErrorMessage(
      'WorkCenter API is unavailable or invalid. Update "mthalman.workcenter".'
    );
    return;
  }

  // api is a WorkCenterApi — register providers and actions here
}
```

### 3. Re-declare API Types

Because provider extensions are separately bundled VS Code extensions, you cannot import types from the core package at runtime. Re-declare the interfaces you need:

```ts
interface Disposable {
  dispose(): void;
}

interface Event<T> {
  (listener: (e: T) => void): Disposable;
}

interface DiscoveredItem {
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  group?: string;
}

interface WorkCenterProvider {
  readonly id: string;
  readonly label: string;
  readonly resurfaceDismissed?: boolean;
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;
  refresh(): Promise<void>;
}
```

---

## Implementing a Provider

A provider discovers items from an external source and reports them to WorkCenter via an event emitter.

### Full Example

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
  readonly resurfaceDismissed?: boolean;
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;
  refresh(): Promise<void>;
}

class JiraProvider implements WorkCenterProvider {
  readonly id = 'jira';
  readonly label = 'Jira Issues';

  // Use vscode.EventEmitter to implement the onDidDiscoverItems event
  private readonly _onDidDiscoverItems =
    new vscode.EventEmitter<DiscoveredItem[]>();
  readonly onDidDiscoverItems = this._onDidDiscoverItems.event;

  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  async refresh(): Promise<void> {
    const tickets = await this.fetchTickets();

    const items: DiscoveredItem[] = tickets.map((ticket) => ({
      // externalId must be unique within this provider and stable across refreshes
      externalId: `${ticket.project}/${ticket.key}`,
      title: `${ticket.key}: ${ticket.summary}`,
      description: ticket.description?.slice(0, 200),
      url: `https://jira.example.com/browse/${ticket.key}`,
      // group organizes items under folders in the Inbox and Sources views
      group: ticket.project,
    }));

    // Each emission replaces the provider's entire item set
    this._onDidDiscoverItems.fire(items);
  }

  /** Start a periodic refresh on a timer. */
  startPeriodicRefresh(intervalSeconds: number): void {
    this.stopPeriodicRefresh();
    const interval = Math.max(intervalSeconds, 60) * 1000;
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) =>
        console.error('Jira refresh failed', err)
      );
    }, interval);
  }

  stopPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  dispose(): void {
    this.stopPeriodicRefresh();
    this._onDidDiscoverItems.dispose();
  }

  private async fetchTickets(): Promise<
    Array<{
      key: string;
      project: string;
      summary: string;
      description?: string;
    }>
  > {
    // Replace with your actual API call
    return [];
  }
}
```

### Key Points

- **EventEmitter pattern** — Use `vscode.EventEmitter<DiscoveredItem[]>` to create the event. Expose its `.event` property as the readonly `onDidDiscoverItems`.
- **`refresh()` is called by WorkCenter** — It is invoked automatically when the provider is registered (for initial discovery) and whenever the user triggers a manual refresh. It must be safe to call multiple times.
- **`externalId` must be unique per provider** — WorkCenter uses the combination of `providerId + externalId` to track inbox state. Use a stable identifier like `owner/repo#123` or `PROJECT/TICKET-42`.
- **`group` is optional** — When set, items with the same group value are nested under a folder node in the Inbox and Sources views.
- **`resurfaceDismissed`** — When `true`, items the user previously dismissed will reappear in the Inbox if the provider re-emits them. This is useful for time-sensitive items (e.g., PR review requests). When `false` or `undefined` (the default), dismissed items stay dismissed.
- **Emit the full set every time** — Each `onDidDiscoverItems` emission replaces all previously known items for that provider. Emit everything currently relevant, not just deltas.

### Periodic Refresh Pattern

For providers that poll an external API, set up a `setInterval` timer. Clamp the interval to a reasonable minimum (e.g., 60 seconds) and guard against overlapping refreshes:

```ts
private _isRefreshing = false;

private async refreshInBackground(): Promise<void> {
  if (this._isRefreshing) {
    return; // Skip if a refresh is already in progress
  }

  this._isRefreshing = true;
  try {
    await this.refresh();
  } finally {
    this._isRefreshing = false;
  }
}
```

### Registering the Provider

```ts
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ... acquire api (see Getting Started) ...

  const provider = new JiraProvider();
  provider.startPeriodicRefresh(300); // every 5 minutes

  // registerProvider returns a Disposable — push it for cleanup
  const registration = api.registerProvider(provider);
  context.subscriptions.push(registration);

  // The provider owns its own resources (timer, emitter) — dispose separately
  context.subscriptions.push({ dispose: () => provider.dispose() });

  // No need to call provider.refresh() manually — registerProvider triggers
  // initial discovery automatically.
}
```

---

## Implementing an Action

An action is an operation users can perform on a work item. Actions appear dynamically in the **Run Action…** quick pick menu on Queue and Focus items.

### Full Example

```ts
import * as vscode from 'vscode';

enum WorkItemState {
  New = 'New',
  Triaged = 'Triaged',
  InProgress = 'InProgress',
  Blocked = 'Blocked',
  WaitingOn = 'WaitingOn',
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
  canRun(item: WorkItem): boolean;
  run(item: WorkItem): Promise<void>;
}

class CreateBranchAction implements WorkCenterAction {
  readonly id = 'jira.createBranch';
  readonly label = 'Create Feature Branch';

  canRun(item: WorkItem): boolean {
    // Only show for Jira items that are new (not yet started)
    return item.providerId === 'jira' && item.state === WorkItemState.New;
  }

  async run(item: WorkItem): Promise<void> {
    if (!item.externalId) {
      vscode.window.showErrorMessage('No external ID found for this item.');
      return;
    }

    const branchName = `feature/${item.externalId.replace(/\//g, '-')}`;
    // ... create git branch, open worktree, etc.
    vscode.window.showInformationMessage(`Created branch: ${branchName}`);
  }
}
```

### Key Points

- **`canRun(item)`** — Called each time the user opens the Run Action menu. Return `true` to show the action for that item. Filter by `providerId`, `state`, or any other `WorkItem` field.
- **`run(item)`** — Executes the action. Throw an error (or show a message via `vscode.window`) to report failures.
- **Actions are provider-agnostic by default** — An action can apply to items from any provider. Use `item.providerId` in `canRun()` to scope it to a specific provider.

### Registering the Action

```ts
const action = new CreateBranchAction();
context.subscriptions.push(api.registerAction(action));
```

---

## Data Flow

Understanding how items move through WorkCenter helps you build effective providers.

```
Provider emits DiscoveredItem[]
        │
        ▼
   ┌─────────┐     accept     ┌─────────┐    start     ┌─────────┐
   │  Inbox   │ ──────────▶   │  Queue   │ ──────────▶  │  Focus  │
   │ (unseen) │               │  (New)   │              │(InProgress,│
   └─────────┘               └─────────┘              │ Blocked,   │
        │                          ▲                    │ WaitingOn) │
     dismiss                       │                    └─────────┘
        │                     manual add                     │
        ▼                          │                      complete
   ┌───────────┐              User creates               │
   │ dismissed  │             item directly              ▼
   │(Sources only)│                                ┌─────────┐
   └───────────┘                                   │ History │
                                                   │(Done,    │
                                                   │ Archived)│
                                                   └─────────┘
```

### What gets persisted

WorkCenter maintains two JSON files in its global storage:

| File | Contents |
|------|----------|
| `workitems.json` | Full `WorkItem` records with state machine lifecycle |
| `discovered-state.json` | Thin index mapping `providerId + externalId` → inbox state (`unseen`, `accepted`, `dismissed`) |

**`DiscoveredItem` fields are not persisted in `discovered-state.json`.** That file stores only inbox state keyed by `providerId + externalId`, which keeps the discovery index lightweight.

When a user **accepts** an item from Inbox or Sources, WorkCenter creates a new `WorkItem` in `workitems.json` with a snapshot of provider-backed fields such as the title and URL, along with provenance metadata (`providerId`, `externalId`).

---

## Best Practices

### Use unique, stable external IDs

The `externalId` is the primary key WorkCenter uses (together with `providerId`) to track inbox state. It must be:
- **Unique** within your provider
- **Stable** across refreshes — the same real-world item must always produce the same `externalId`
- **Deterministic** — avoid random suffixes or timestamps

Good patterns: `owner/repo#123`, `PROJECT-42`, `ticket/12345`

### Keep refresh lightweight

`refresh()` may be called frequently (on registration, on user request, on a timer). Avoid heavy processing:
- Cache API responses where appropriate
- Guard against overlapping refreshes with a boolean flag
- Clamp periodic intervals to a reasonable minimum (≥ 60 seconds)

### Don't store provider item data

WorkCenter reads `DiscoveredItem` data live from the provider. There is no need to persist item details on your side — just emit the current set on each refresh. This ensures the UI always shows the latest data.

### Dispose subscriptions properly

- Push the `Disposable` returned by `registerProvider()` / `registerAction()` into `context.subscriptions`
- Provider resources (timers, event emitters) are **not** disposed by WorkCenter — clean them up yourself
- Use a `dispose()` method on your provider class and push it into `context.subscriptions`

```ts
context.subscriptions.push(api.registerProvider(provider));
context.subscriptions.push({ dispose: () => provider.dispose() });
```

### Emit the complete item set

Each `onDidDiscoverItems` emission **replaces** the provider's entire known item set. Always emit all current items, not incremental changes.

### Use `group` for organization

Set the `group` field on `DiscoveredItem` to organize items under folder nodes in the Inbox and Sources views. For example, a GitHub provider groups issues by repository name.

---

## API Reference

### `WorkCenterApi`

The entry point returned by the core extension's `activate()` / `exports`.

```ts
interface WorkCenterApi {
  /**
   * Register a provider that discovers items from an external source.
   * WorkCenter calls provider.refresh() immediately upon registration.
   * @returns A Disposable that unregisters the provider when disposed.
   */
  registerProvider(provider: WorkCenterProvider): Disposable;

  /**
   * Register an action that can be performed on work items.
   * Actions appear in the "Run Action…" quick pick menu.
   * @returns A Disposable that unregisters the action when disposed.
   */
  registerAction(action: WorkCenterAction): Disposable;
}
```

### `WorkCenterProvider`

Implemented by extensions that discover items from an external source.

```ts
interface WorkCenterProvider {
  /** Unique identifier for this provider (e.g., 'github', 'jira'). */
  readonly id: string;

  /** Human-readable label shown in the UI (e.g., 'GitHub Issues'). */
  readonly label: string;

  /**
   * If true, previously dismissed items reappear in the Inbox
   * when re-emitted. Defaults to false.
   * Useful for time-sensitive items like PR review requests.
   */
  readonly resurfaceDismissed?: boolean;

  /**
   * Event that fires when the provider has items to report.
   * Each emission replaces the provider's entire item set.
   */
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;

  /**
   * Called by WorkCenter on registration and on user-triggered refresh.
   * Must be safe to call multiple times.
   */
  refresh(): Promise<void>;
}
```

### `DiscoveredItem`

Represents an item discovered by a provider.

```ts
interface DiscoveredItem {
  /**
   * Unique identifier within the provider. Must be stable across refreshes.
   * WorkCenter uses providerId + externalId to track inbox state.
   */
  externalId: string;

  /** Title displayed in the Inbox and Sources views. */
  title: string;

  /** Optional description shown in tooltips. */
  description?: string;

  /** Optional URL for "Open in Browser" support. */
  url?: string;

  /**
   * Optional group name for sub-grouping in the Inbox and Sources views.
   * Items with the same group appear under a folder node.
   */
  group?: string;
}
```

### `WorkCenterAction`

Implemented by extensions that add operations for work items.

```ts
interface WorkCenterAction {
  /** Unique identifier for this action (e.g., 'github.startWork'). */
  readonly id: string;

  /** Human-readable label shown in the quick pick menu. */
  readonly label: string;

  /**
   * Returns true if this action applies to the given item.
   * Called each time the user opens the Run Action menu.
   */
  canRun(item: WorkItem): boolean;

  /**
   * Executes the action. Throw an error to surface it to the user.
   */
  run(item: WorkItem): Promise<void>;
}
```

### `WorkItem`

The persisted work item model passed to actions.

```ts
interface WorkItem {
  /** Internal unique ID generated by WorkCenter. */
  id: string;

  /** User-visible title. */
  title: string;

  /** Optional user-added notes. */
  notes?: string;

  /** Current state in the lifecycle. */
  state: WorkItemState;

  /** Provider ID if this item originated from a provider. */
  providerId?: string;

  /** External ID from the provider. */
  externalId?: string;

  /** URL associated with the item. */
  url?: string;

  /** Ordering hint for the Queue view. Managed by WorkCenter. */
  sortOrder?: number;

  /** Timestamp (ms since epoch) when the item was created. */
  createdAt: number;

  /** Timestamp (ms since epoch) when the item was last updated. */
  updatedAt: number;
}
```

### `WorkItemState`

```ts
enum WorkItemState {
  New = 'New',         // Queue — freshly created or accepted
  Triaged = 'Triaged', // Reserved for future use
  InProgress = 'InProgress', // Focus — active work
  Blocked = 'Blocked',       // Focus — cannot proceed
  WaitingOn = 'WaitingOn',   // Focus — waiting on external dependency
  Done = 'Done',             // History — completed
  Archived = 'Archived',     // History — archived
}
```

### `Disposable`

```ts
interface Disposable {
  /** Release resources held by this object. */
  dispose(): void;
}
```

### `Event<T>`

```ts
interface Event<T> {
  /**
   * Subscribe to this event.
   * @returns A Disposable that removes the listener when disposed.
   */
  (listener: (e: T) => void): Disposable;
}
```

---

## Further Reading

- [Extension API reference](./extension-api.md) — Detailed API walkthrough with additional examples
- [`packages/github`](../packages/github/src/) — Production provider implementation (GitHub Issues, PR reviews, Start Work action)
