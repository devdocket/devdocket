# Provider Discovery Conditions

This document explains what conditions cause work items and reviews to appear in DevDocket's Inbox and Sources views. Each provider discovers items based on specific criteria — if an item meets those criteria, it shows up automatically.

## Table of Contents

- [GitHub Issues](#github-issues)
- [GitHub PR Reviews](#github-pr-reviews)
- [Azure DevOps Work Items](#azure-devops-work-items)
- [Azure DevOps PR Reviews](#azure-devops-pr-reviews)
- [Common Behavior](#common-behavior)
  - [Refresh Intervals](#refresh-intervals)
  - [Item Lifecycle (Inbox States)](#item-lifecycle-inbox-states)
  - [Resurfacing](#resurfacing)
  - [Troubleshooting](#troubleshooting)

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

1. **First pass:** Excludes items with state names `Closed` or `Removed` (covers the most common cases)
2. **Second pass:** Checks each work item type's state definitions and excludes items whose state falls into a **terminal state category** (Completed, Removed, or Resolved)

This means items are correctly filtered regardless of your process template. For example, a Scrum "Done" item (category: Completed) is excluded even though its state name isn't "Closed".

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `devdocketAdo.projects` | `[]` | Organizations and projects to monitor. Each entry is `<org>` (entire organization) or `<org>/<project>` (specific project). At least one entry is required for the ADO providers to discover items. |
| `devdocketAdo.refreshIntervalSeconds` | `300` (5 min) | How often to poll for changes. Minimum 60 seconds. Set to 0 to disable. |

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

### Item Lifecycle (Inbox States)

When a provider discovers an item, it enters the **Inbox** as an unseen item. From there:

```
Provider discovers item
        │
        ▼
   ┌─────────┐
   │ Unseen  │  ← Appears in Inbox
   └────┬────┘
        │
   ┌────┴────┐
   │         │
   ▼         ▼
┌──────┐  ┌───────────┐
│Accept│  │  Dismiss   │
└──┬───┘  └─────┬─────┘
   │            │
   ▼            ▼
┌──────────┐  ┌───────────┐
│ Accepted │  │ Dismissed │  ← Hidden from Inbox
└──────────┘  └───────────┘
```

- **Unseen** — New item in your Inbox, waiting for you to triage it.
- **Accepted** — You've accepted the item; it becomes a work item in your Queue.
- **Dismissed** — You've dismissed the item. It will **not** reappear, even if the provider keeps discovering it.

### Resurfacing

Some providers track **versions** of discovered items. When a version changes on an item you previously accepted, the item is moved back to **Unseen** so it reappears in your Inbox. This lets you know something has changed.

**GitHub PR Reviews** support two independent resurfacing signals:

| Signal | Tracked via | Setting |
|--------|-------------|---------|
| New commits pushed to the PR | HEAD commit SHA | `devdocketGithub.resurfaceOnNewVersion` |
| Review explicitly re-requested | Timeline event timestamp | `devdocketGithub.resurfaceOnReRequestedReview` |

**Azure DevOps PR Reviews** support one resurfacing signal:

| Signal | Tracked via | Setting |
|--------|-------------|---------|
| New iterations pushed to the PR | Last merge source commit ID | `devdocketAdo.resurfaceOnNewVersion` |

**Dismissed items are never resurfaced.** Only accepted items can be resurfaced by version changes.

### Troubleshooting

**Items not appearing?** Check these common causes:

1. **Not authenticated** — Ensure you're signed into GitHub or Microsoft in VS Code. DevDocket uses VS Code's built-in authentication. Background refreshes won't prompt for sign-in; trigger a manual refresh to get the auth prompt.
2. **Wrong repository/project config** — Verify `devdocketGithub.repos` or `devdocketAdo.projects` includes the correct repositories or organizations. Leave the setting empty to include everything.
3. **Invalid format** — Repository entries must be in `owner/repo` format (GitHub) or `org` / `org/project` format (ADO). Malformed entries are skipped (GitHub logs a warning to the output channel; ADO skips silently).
4. **Item already dismissed** — Dismissed items never reappear. Check the Sources view to see all items the provider knows about, regardless of inbox state.
5. **Terminal state** — ADO work items in Closed, Done, Removed, or other terminal states are excluded.
6. **Provider unhealthy** — Check the Sources view for providers showing "refresh failed". This indicates an authentication or network issue.
7. **Item limit** — Each provider is limited to 10,000 discovered items. Items beyond this limit are discarded.

**Items appearing unexpectedly?**

1. **Resurfacing** — An accepted PR review may reappear if new commits were pushed or a review was re-requested. Disable this via the `resurfaceOnNewVersion` or `resurfaceOnReRequestedReview` settings.
2. **Multiple repositories** — If `devdocketGithub.repos` is empty, issues from all repositories you're assigned to will appear. Configure the setting to limit scope.
