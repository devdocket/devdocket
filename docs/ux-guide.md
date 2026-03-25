# WorkCenter UX Guide

WorkCenter is a VS Code extension that provides a unified hub for managing work items from multiple sources. This guide covers the four-view model, data flow, work item lifecycle, and available actions.

## The Four Views

WorkCenter organizes work across four views, accessible from the WorkCenter activity bar icon.

### Inbox

The Inbox shows newly discovered items from providers that you haven't acted on yet. Items appear here automatically when a provider (such as GitHub Issues) discovers them.

Each provider's items are grouped under the provider name with a count of unseen items. Only providers with unseen items appear in the Inbox.

**Available actions on Inbox items:**

| Action | Description |
|--------|-------------|
| **Accept to Queue** | Creates a work item in the Queue and marks the provider item as accepted |
| **Dismiss** | Hides the item from the Inbox (it remains visible in Sources) |
| **Open in Browser** | Opens the item's URL in your default browser (if the item has a URL) |

### Queue

The Queue is your curated backlog — items you've decided to work on but haven't started yet. Items arrive here in two ways:

1. **Accepted from Inbox or Sources** — provider-discovered items you've chosen to keep.
2. **Manually created** — items you add yourself using the **Create Work Item** button (➕) in the Queue title bar.

All items in the Queue are in the **New** state.

**Available actions on Queue items:**

| Action | Description |
|--------|-------------|
| **Move to Focus** | Transitions the item to **InProgress** and moves it to the Focus view |
| **Archive** | Transitions the item to **Archived**, removing it from the Queue |
| **Edit Work Item** | Opens the editor panel to modify title and description |
| **Run Action…** | Shows available provider actions for this item |
| **Open in Browser** | Opens the item's URL in your default browser (if the item has a URL) |

### Focus

The Focus view shows items you are actively working on. Items here can be in one of three states: **InProgress**, **Blocked**, or **WaitingOn**.

Items display a state label next to the title, with icons indicating status:
- **in progress** — actively being worked on (shown with a separate in-progress icon)
- **blocked** — work is blocked by an external dependency (prefixed with a ⛔ icon)
- **waiting** — waiting on someone or something (shown as `⏳ waiting`)

**Available actions on Focus items:**

| Action | Description |
|--------|-------------|
| **Complete** | Transitions the item to **Done** (inline button) |
| **Mark Blocked** | Transitions an active item to **Blocked** |
| **Unblock** | Transitions a blocked/waiting item back to **InProgress** |
| **Mark Waiting On** | Transitions an active item to **WaitingOn** |
| **Edit Work Item** | Opens the editor panel to modify title and description |
| **Run Action…** | Shows available provider actions for this item |
| **Open in Browser** | Opens the item's URL in your default browser (if the item has a URL) |

> **Note:** The **Mark Blocked** and **Mark Waiting On** actions are only available on active (InProgress) items. The **Unblock** action is only available on blocked or waiting items.

### Sources

Sources is a browsable library of everything providers know about, regardless of inbox state. Items are organized in a tree: **Provider → Group → Item**.

- Providers appear at the top level.
- Groups (e.g., repository names) appear as folders under each provider.
- Ungrouped items appear directly under their provider.
- Items show a ✓ icon if already accepted, and a "dismissed" label if previously dismissed.

**Available actions on Source items:**

| Action | Description |
|--------|-------------|
| **Accept to Queue** | Creates a work item in the Queue (or re-accepts a previously accepted item) |
| **Open in Browser** | Opens the item's URL in your default browser (if the item has a URL) |

## Data Flow

Items flow through WorkCenter in a defined progression:

```
Provider discovers items
        │
        ▼
┌──────────────┐
│    Inbox     │  (unseen provider items)
│   [unseen]   │
└──────┬───────┘
       │ Accept ──────────────────────────────┐
       │ Dismiss → item stays in Sources only │
       ▼                                      │
┌──────────────┐                              │
│    Queue     │  ◄── Manual "Create Item"    │
│   [New]      │  ◄───────────────────────────┘
└──────┬───────┘
       │ Move to Focus
       │ (or Archive to skip)
       ▼
┌──────────────┐
│    Focus     │
│ [InProgress] │ ◄──► [Blocked]
│              │ ◄──► [WaitingOn]
└──────┬───────┘
       │ Complete
       ▼
┌──────────────┐
│    Done      │  (terminal state — hidden from active views)
└──────────────┘
```

**Sources** sits alongside this flow as a read-only view of all provider data. You can accept items from Sources into the Queue at any time.

## Manual Item Creation

To create a work item manually:

1. Open the **Queue** view in the WorkCenter sidebar.
2. Click the **➕** (Create Work Item) button in the Queue title bar.
3. Enter a title in the input box (required).
4. The item appears in the Queue in the **New** state.

Manually created items have no `providerId` or `externalId` — they exist only within WorkCenter.

## Provider Items Lifecycle

Provider items (e.g., GitHub issues) follow this lifecycle:

1. **Discovery** — A provider emits items via `onDidDiscoverItems`. These items appear in both **Sources** (always) and **Inbox** (if unseen).

2. **Inbox state** — Each provider item is tracked with an inbox state:
   - `unseen` — Appears in the Inbox (default for new items).
   - `accepted` — Removed from Inbox; a corresponding work item exists in Queue/Focus.
   - `dismissed` — Removed from Inbox; still visible in Sources with a "dismissed" label.

3. **Acceptance** — When you accept an item (from Inbox or Sources), WorkCenter creates a persisted work item that stores a snapshot of the provider's title, description, and URL at that time, along with the mapping back to the provider item. Provider items shown in **Sources** are read live from the provider; both the inbox state mapping and the accepted work item are persisted.

4. **Duplicate prevention** — Accepting an item that was already accepted shows a notification instead of creating a duplicate.

## Work Item States and Transitions

WorkCenter defines seven states for work items:

| State | View | Description |
|-------|------|-------------|
| **New** | Queue | Item is in the backlog, waiting to be started |
| **Triaged** | — | Reserved for future use |
| **InProgress** | Focus | Item is actively being worked on |
| **Blocked** | Focus | Work is blocked by an external dependency |
| **WaitingOn** | Focus | Waiting on someone or something |
| **Done** | — | Work is complete |
| **Archived** | — | Item is archived and hidden from active views |

### State Transition Diagram

```
                    ┌──────────┐
                    │   New    │  (Queue)
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
              ▼          │          ▼
        ┌──────────┐     │    ┌──────────┐
        │InProgress│     │    │ Archived │
        └────┬─────┘     │    └──────────┘
             │           │
     ┌───────┼───────┐   │
     │       │       │   │
     ▼       ▼       │   │
┌─────────┐ ┌──────────┐ │   │
│ Blocked │ │WaitingOn │ │   │
└────┬────┘ └────┬─────┘ │   │
     │         │     │   │
     └────┬────┘     │   │
          │          │   │
          ▼          │   │
    ┌──────────┐     │   │
    │InProgress│ ◄───┘   │
    └────┬─────┘         │
         │               │
         ▼               │
    ┌──────────┐         │
    │   Done   │         │
    └──────────┘         │
                         │
    ┌──────────┐         │
    │ Archived │ ◄───────┘
    └──────────┘
```

**Valid transitions:**

- **New → InProgress** — "Move to Focus" from Queue
- **New → Archived** — "Archive" from Queue (skip/dismiss)
- **InProgress → Blocked** — "Mark Blocked" from Focus
- **InProgress → WaitingOn** — "Mark Waiting On" from Focus
- **InProgress → Done** — "Complete" from Focus
- **Blocked → InProgress** — "Unblock" from Focus
- **WaitingOn → InProgress** — "Unblock" from Focus
- **Done → Archived** — Not currently exposed; Done is a terminal state

## Available Commands

Commands are available from context menus, inline actions, or the view title bar in their respective views. Commands are registered under the **WorkCenter** category.

| Command | ID | Available In | Icon |
|---------|----|-------------|------|
| Create Work Item | `workcenter.createItem` | Queue (title bar) | $(add) |
| Move to Focus | `workcenter.acceptToFocus` | Queue (inline) | $(arrow-right) |
| Archive | `workcenter.archiveItem` | Queue (context menu) | $(archive) |
| Complete | `workcenter.completeItem` | Focus (inline) | $(check) |
| Mark Blocked | `workcenter.blockItem` | Focus (context, active items) | $(circle-slash) |
| Unblock | `workcenter.unblockItem` | Focus (context, blocked items) | $(debug-continue) |
| Mark Waiting On | `workcenter.markWaitingOn` | Focus (context, active items) | $(clock) |
| Edit Work Item | `workcenter.editItem` | Queue, Focus (context menu) | $(edit) |
| Open in Browser | `workcenter.openInBrowser` | Any view (items with URL) | $(link-external) |
| Run Action… | `workcenter.runAction` | Queue, Focus (context menu) | $(play) |
| Accept to Queue | `workcenter.acceptFromInbox` | Inbox (inline) | $(arrow-down) |
| Dismiss | `workcenter.dismissFromInbox` | Inbox (context menu) | $(close) |
| Accept to Queue | `workcenter.acceptFromSources` | Sources (inline, items only) | $(arrow-down) |

## Editor Panel

The **Edit Work Item** command opens a webview-based editor panel with two fields:

- **Title** — A single-line text input (required). Cannot be saved if empty.
- **Description** — A multi-line textarea for additional notes.

The editor **auto-saves** changes after a 500ms debounce. There is no explicit save button — edits are persisted automatically as you type. The panel title updates to reflect the current item title.

The editor uses VS Code's native theming, matching your current color scheme for inputs, buttons, and text.
