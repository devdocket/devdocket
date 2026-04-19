# Provider Discovery Conditions

This document explains what conditions cause work items and reviews to appear in DevDocket's Inbox and Sources views. Each provider discovers items based on specific criteria — if an item meets those criteria, it shows up automatically.

## Table of Contents

- [Discovery Overview](#discovery-overview)
- [GitHub Issues](#github-issues)
- [GitHub PR Reviews](#github-pr-reviews)
- [GitHub My PRs](#github-my-prs)
- [Azure DevOps Work Items](#azure-devops-work-items)
- [Azure DevOps PR Reviews](#azure-devops-pr-reviews)
- [Common Behavior](#common-behavior)
  - [Refresh Intervals](#refresh-intervals)
  - [Item Lifecycle (Inbox States)](#item-lifecycle-inbox-states)
  - [Resurfacing](#resurfacing)
  - [Troubleshooting](#troubleshooting)

---

## Discovery Overview

The following diagram shows how items flow from external systems into DevDocket's views:

```mermaid
flowchart LR
    subgraph External["External Systems"]
        GH["GitHub API"]
        ADO["Azure DevOps API"]
    end

    subgraph Providers["Provider Extensions"]
        GHI["GitHub Issues\nProvider"]
        GHPR["GitHub PR Reviews\nProvider"]
        GHMY["GitHub My PRs\nProvider"]
        ADOWI["ADO Work Items\nProvider"]
        ADOPR["ADO PR Reviews\nProvider"]
    end

    subgraph Core["DevDocket Core"]
        PR["ProviderRegistry"]
        SS["DiscoveredStateStore"]
        subgraph Views
            Inbox["Inbox\n(unseen)"]
            Sources["Sources\n(all items)"]
            Queue["Queue\n(accepted)"]
        end
    end

    GH --> GHI
    GH --> GHPR
    GH --> GHMY
    ADO --> ADOWI
    ADO --> ADOPR

    GHI -- "DiscoveredItem[]" --> PR
    GHPR -- "DiscoveredItem[]" --> PR
    GHMY -- "DiscoveredItem[]" --> PR
    ADOWI -- "DiscoveredItem[]" --> PR
    ADOPR -- "DiscoveredItem[]" --> PR

    PR -- "new items" --> Inbox
    PR -- "all items" --> Sources
    Inbox -- "user accepts" --> Queue
```

---

## GitHub Issues

**Provider:** DevDocket GitHub  
**Condition:** The issue is **assigned to you** and **open**.

An issue appears when **all** of the following are true:

| Condition | Details |
|-----------|---------|
| **Assigned to you** | You are listed as an assignee on the issue |
| **Open state** | The issue is not closed |
| **Not a pull request** | Only issues appear here, not PRs |
| **Repository match** | If `devdocketGithub.repos` is configured, only issues from those repos appear. Otherwise, assigned issues across all repositories are included (up to 1,000 items due to pagination limits). |

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `devdocketGithub.repos` | `[]` (all repos) | List of repositories to watch, in `owner/repo` format. Leave empty to include all repositories where you have assigned issues. |
| `devdocketGithub.refreshIntervalSeconds` | `300` (5 min) | How often to poll for changes. Minimum 60 seconds. |

### What does NOT cause issues to appear

- Being **mentioned** in an issue (only assignment counts)
- Being the **author** of an issue (unless also assigned)
- Issues you are **subscribed** to
- Issues with a specific **label** (there is no label filter)
- **Closed** issues, even if assigned to you

---

## GitHub PR Reviews

**Provider:** DevDocket GitHub  
**Condition:** You have a **pending review request** on an **open** pull request.

A PR review appears when **all** of the following are true:

| Condition | Details |
|-----------|---------|
| **Review requested from you** | You are explicitly listed as a requested reviewer |
| **Open state** | The PR is not closed or merged |
| **Repository match** | If `devdocketGithub.repos` is configured, only PRs from those repos appear. Otherwise, review requests across all repositories are included (up to 100 results due to GitHub Search API limits). |

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `devdocketGithub.repos` | `[]` (all repos) | Same repo filter as GitHub Issues. |
| `devdocketGithub.refreshIntervalSeconds` | `300` (5 min) | Shared with GitHub Issues. |
| `devdocketGithub.resurfaceOnNewVersion` | `true` | When enabled, a PR you've already accepted reappears in your Inbox if new commits are pushed. |
| `devdocketGithub.resurfaceOnReRequestedReview` | `true` | When enabled, a PR reappears if the author explicitly re-requests your review. |

### What does NOT cause PR reviews to appear

- Being **mentioned** in a PR
- Being **assigned** to a PR (only review requests count)
- Being the **author** of a PR
- PRs you have **already reviewed** (unless review is re-requested)
- **Closed** or **merged** PRs

---

## GitHub My PRs

**Provider:** DevDocket GitHub  
**Condition:** You are the **author** of an **open** pull request.

A PR appears when **all** of the following are true:

| Condition | Details |
|-----------|---------|
| **Authored by you** | You created the pull request |
| **Open state** | The PR is not closed or merged |
| **Repository match** | If `devdocketGithub.repos` is configured, only PRs from those repos appear. Otherwise, your authored PRs across all repositories are included (up to 100 results due to GitHub Search API limits). |

Each discovered PR is enriched with its current status: Draft, Waiting on reviews, Review received, Changes requested, Approved, or Ready to merge.

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `devdocketGithub.repos` | `[]` (all repos) | Same repo filter as GitHub Issues. |
| `devdocketGithub.refreshIntervalSeconds` | `300` (5 min) | Shared with GitHub Issues. |

### What does NOT cause your PRs to appear

- PRs where you are a **reviewer** but not the author
- PRs you are **assigned** to but did not author
- **Closed** or **merged** PRs
- **Draft** PRs still appear (with "Draft" status)

---

## Azure DevOps Work Items

**Provider:** DevDocket — Azure DevOps  
**Condition:** The work item is **assigned to you** and in an **active state**.

A work item appears when **all** of the following are true:

| Condition | Details |
|-----------|---------|
| **Assigned to you** | You are the `Assigned To` user on the work item |
| **Not in a terminal state** | The work item is not in a state categorized as Completed, Removed, or Resolved |
| **Organization/project match** | Only work items from your configured organizations and projects appear |

### State filtering

ADO uses a two-layer filter to handle the variety of process templates (Agile, Scrum, CMMI, custom):

```mermaid
flowchart TD
    A["WIQL Query\nAssigned to @Me"] --> B["First pass:\nExclude State = 'Closed'\nExclude State = 'Removed'"]
    B --> C["Fetch work item details\n(batches of 200)"]
    C --> D["Second pass:\nFetch state categories\nper work item type"]
    D --> E{State category\nterminal?}
    E -- "Completed /\nRemoved /\nResolved" --> F["Excluded"]
    E -- "Active /\nProposed /\nother" --> G["Included in\ndiscovered items"]
```

1. **First pass:** Excludes items with state names `Closed` or `Removed` (covers the most common cases)
2. **Second pass:** Checks each work item type's state definitions and excludes items whose state falls into a **terminal state category** (Completed, Removed, or Resolved)

This means items are correctly filtered regardless of your process template. For example, a Scrum "Done" item (category: Completed) is excluded even though its state name isn't "Closed".

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `devdocketAdo.projects` | `[]` | Organizations and projects to monitor. Each entry is `<org>` (entire organization) or `<org>/<project>` (specific project). At least one entry is required for the ADO providers to discover items. |
| `devdocketAdo.refreshIntervalSeconds` | `300` (5 min) | How often to poll for changes. Minimum 60 seconds. Set to 0 or a negative value to disable. |

### What does NOT cause work items to appear

- Work items you **created** (unless also assigned to you)
- Work items where you are in the **activity** or **discussion** but not assigned
- Work items in **Closed**, **Done**, **Removed**, or other terminal states
- Work items from organizations/projects not listed in `devdocketAdo.projects`

---

## Azure DevOps PR Reviews

**Provider:** DevDocket — Azure DevOps  
**Condition:** You are a **reviewer** on an **active** pull request.

A PR review appears when **all** of the following are true:

| Condition | Details |
|-----------|---------|
| **You are a reviewer** | You are listed as a reviewer on the PR (required, optional, or any reviewer role) |
| **Active status** | The PR is not completed, abandoned, or in any other non-active state |
| **Organization/project match** | Only PRs from your configured organizations and projects appear |

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `devdocketAdo.projects` | `[]` | Same org/project filter as ADO Work Items. At least one entry is required. |
| `devdocketAdo.refreshIntervalSeconds` | `300` (5 min) | Shared with ADO Work Items. |
| `devdocketAdo.resurfaceOnNewVersion` | `true` | When enabled, a PR you've already accepted reappears in your Inbox if new iterations (commits) are pushed. Note: ADO does not support re-request-based resurfacing (unlike GitHub). |

### What does NOT cause ADO PR reviews to appear

- PRs you **created** (unless also added as a reviewer)
- PRs where you are only in a **comment thread**
- **Completed** or **abandoned** PRs

---

## Common Behavior

### Refresh Intervals

All providers poll their data source periodically. The default interval is **5 minutes** (300 seconds).

- **Minimum:** 60 seconds (values below 60 are automatically clamped to 60)
- **Disable:** Set the interval to `0` or a negative value to stop automatic polling
- **Manual refresh:** You can always trigger a refresh manually via the DevDocket refresh command, regardless of the interval setting

```mermaid
flowchart TD
    A["Timer fires\n(every N seconds)"] --> B{Already\nrefreshing?}
    B -- Yes --> C[Skip]
    B -- No --> D{Authenticated?}
    D -- No --> E["Background: skip silently\nManual: prompt sign-in"]
    D -- Yes --> F["Query external API"]
    F --> G{Success?}
    G -- Yes --> H["Emit DiscoveredItem[]\nMark provider healthy"]
    G -- No --> I["Log error\nMark provider unhealthy"]
    H --> J["ProviderRegistry\nprocesses items"]
    I --> K["Timer continues\n(next interval)"]
    J --> K

    M["User triggers\nmanual refresh"] --> D
```

### Item Lifecycle (Inbox States)

When a provider discovers an item, it enters the **Inbox** as an unseen item. From there:

```mermaid
stateDiagram-v2
    [*] --> Unseen : Provider discovers item

    Unseen --> Accepted : User accepts
    Unseen --> Dismissed : User dismisses

    Accepted --> Unseen : Version changes\n(resurfacing)

    note right of Unseen : Appears in Inbox
    note right of Accepted : Creates a work item\nin the Queue
    note right of Dismissed : Permanently hidden\n(never resurfaced)
```

- **Unseen** — New item in your Inbox, waiting for you to triage it.
- **Accepted** — You've accepted the item; it becomes a work item in your Queue.
- **Dismissed** — You've dismissed the item. It will **not** reappear, even if the provider keeps discovering it.

### Resurfacing

Some providers track **versions** of discovered items. When a version changes on an item you previously accepted, the item is moved back to **Unseen** so it reappears in your Inbox. This lets you know something has changed.

```mermaid
flowchart TD
    A["Provider emits item\nwith version"] --> B{Item exists\nin state store?}
    B -- No --> C["Add as Unseen\n(new discovery)"]
    B -- Yes --> D{Current\ninbox state?}
    D -- Unseen --> E["Update stored\nversion"]
    D -- Dismissed --> F["No action\n(never resurface)"]
    D -- Accepted --> G{Version\nchanged?}
    G -- No --> H{Version\nmissing in store?}
    H -- Yes --> I["Backfill version\n(keep Accepted)"]
    H -- No --> J["No action"]
    G -- Yes --> K["Resurface → Unseen\n(reappears in Inbox)"]
```

**GitHub PR Reviews** support two independent resurfacing signals:

| Signal | Tracked via | Setting |
|--------|-------------|---------|
| New commits pushed to the PR | HEAD commit SHA | `devdocketGithub.resurfaceOnNewVersion` |
| Review explicitly re-requested | Timeline event timestamp | `devdocketGithub.resurfaceOnReRequestedReview` |

> **Note:** Re-request detection is best-effort. Only the first page of PR timeline events (up to 100) is checked, so on PRs with extensive activity the latest re-request event may be missed.

**Azure DevOps PR Reviews** support one resurfacing signal:

| Signal | Tracked via | Setting |
|--------|-------------|---------|
| New iterations pushed to the PR | Last merge source commit ID | `devdocketAdo.resurfaceOnNewVersion` |

**Dismissed items are never resurfaced.** Only accepted items can be resurfaced by version changes.

### Troubleshooting

**Items not appearing?** Check these common causes:

1. **Not authenticated** — Ensure you're signed into GitHub or Microsoft in VS Code. DevDocket uses VS Code's built-in authentication. Background refreshes won't prompt for sign-in; trigger a manual refresh to get the auth prompt.
2. **Wrong repository/project config** — Verify `devdocketGithub.repos` or `devdocketAdo.projects` includes the correct repositories or organizations. For GitHub, leaving `devdocketGithub.repos` empty includes all repositories. For ADO, at least one entry in `devdocketAdo.projects` is required — an empty list disables ADO discovery entirely.
3. **Invalid format** — GitHub repo entries must be in `owner/repo` format; invalid entries are logged as warnings and skipped by the issues provider (the PR review provider will report them as fetch failures instead). ADO entries must be `org` or `org/project`; individual malformed entries are silently skipped, but if all entries are invalid the ADO providers will not activate.
4. **Item already dismissed** — Dismissed items never reappear. Check the Sources view to see all items the provider knows about, regardless of inbox state.
5. **Terminal state** — ADO work items in Closed, Done, Removed, or other terminal states are excluded.
6. **Provider unhealthy** — Check the Sources view for providers showing "refresh failed". This indicates an authentication or network issue.
7. **Item limit** — Each provider is limited to 10,000 discovered items per refresh. If a provider emits more than 10,000 items, only the first 10,000 are kept and a warning is logged.

**Items appearing unexpectedly?**

1. **Resurfacing** — An accepted PR review may reappear if new commits were pushed or a review was re-requested. Disable this via the `resurfaceOnNewVersion` or `resurfaceOnReRequestedReview` settings.
2. **Multiple repositories** — If `devdocketGithub.repos` is empty, issues from all repositories you're assigned to will appear. Configure the setting to limit scope.
