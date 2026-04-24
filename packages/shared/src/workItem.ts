/**
 * Discriminated activity types tracked in the work item activity log.
 *
 * - `created` — item was created (manual or from provider).
 * - `state-changed` — lifecycle state transition.
 * - `updated` — user edited title or notes.
 * - `action-executed` — an extension-defined action was run.
 * - `auto-completed` — item was automatically completed because the linked external item was closed/merged.
 * - `work-started` — a branch and/or worktree was created for this item.
 * - `cleanup` — git branch and/or worktree was cleaned up.
 * - `cleanup-dismissed` — user declined cleanup prompt for this item.
 * - `version-updated` — a provider version change was suppressed because the item is in Queue or Focus.
 */
export type ActivityType = 'created' | 'state-changed' | 'updated' | 'action-executed' | 'auto-completed' | 'work-started' | 'cleanup' | 'cleanup-dismissed' | 'version-updated';

/**
 * A single, immutable entry in a work item's activity log.
 *
 * Entries are append-only; the log is trimmed from the front when the
 * maximum entry count is exceeded.
 */
export interface ActivityLogEntry {
  /** Epoch timestamp (ms) when the activity occurred. */
  timestamp: number;
  /** The kind of activity. */
  type: ActivityType;
  /** Optional human-readable detail (e.g. "New → InProgress"). */
  detail?: string;
}

/**
 * Lifecycle states for a {@link WorkItem}.
 *
 * Items move through these states following the work-item state machine:
 *
 * ```
 * New ⇄ InProgress ⇄ Paused
 *  ↑↓       ↓           ↓
 *  ↑      Done  ←───────┘
 *  ↑        ↓
 *  └──── Archived
 * ```
 *
 * Valid transitions:
 * - New → InProgress | Done | Archived
 * - InProgress → Paused | Done | New | Archived
 * - Paused → InProgress | Done | New | Archived
 * - Done → Archived | New
 * - Archived → New
 *
 * New and Paused may transition directly to Done (e.g. when an external
 * issue is closed or merged while the work item is still queued or paused).
 * InProgress and Paused may transition back to New (returning to Queue).
 * Done and Archived may also transition back to New (for re-work after
 * discovering the item was not actually complete).
 * InProgress, Paused, and Done may transition directly to Archived
 * (for abandoned or no-longer-relevant work).
 */
export enum WorkItemState {
  /** Freshly created or accepted from the Inbox; sits in the Queue. */
  New = 'New',
  /** Actively being worked on; shown in the Focus view. */
  InProgress = 'InProgress',
  /** Work is temporarily on hold; shown in the Focus view. */
  Paused = 'Paused',
  /** Work is complete; shown in History. */
  Done = 'Done',
  /** Removed from active views; retained in History for reference. */
  Archived = 'Archived',
}

/**
 * A persisted work item managed by the WorkGraph.
 *
 * Work items may originate from a provider (e.g. a GitHub issue) or be created
 * manually by the user. Provider-backed items carry {@link providerId} and
 * {@link externalId} so they can be correlated with the live provider data.
 */
export interface WorkItem {
  /** Unique identifier (auto-generated on creation). */
  id: string;
  /** Short human-readable title displayed in tree views. */
  title: string;
  /** Optional free-form notes or description. */
  notes?: string;
  /** Current lifecycle state of the work item. */
  state: WorkItemState;
  /** ID of the provider that originally discovered this item, if any. */
  providerId?: string;
  /** Provider-scoped identifier used to correlate with the provider's discovered item. */
  externalId?: string;
  /** URL to the item in its source system (e.g. GitHub issue page). */
  url?: string;
  /** Optional grouping key for organizing items within a provider in tree views. */
  group?: string;
  /** Whether this item represents a pull request. When true and a URL is present, enables Watch CI in the context menu. */
  isPullRequest?: boolean;
  /** Ordering key within items of the same state. Lower values sort first. */
  sortOrder?: number;
  /** Epoch timestamp (ms) when the item was created. */
  createdAt: number;
  /** Epoch timestamp (ms) of the last modification. */
  updatedAt: number;
  /** Append-only log of significant events on this work item. */
  activityLog?: ActivityLogEntry[];
}

/**
 * Editable fields of a work item, used as input for creation and
 * (via `Partial<WorkItemInput>`) for updates.
 */
export interface WorkItemInput {
  /** Short human-readable title of the work item. */
  title: string;
  /** Optional free-form notes or description. */
  notes?: string;
  /** Optional URL to the item in its source system (e.g. GitHub issue page). */
  url?: string;
}
