/**
 * Lifecycle states for a {@link WorkItem}.
 *
 * Typical flow: `New` → `Triaged` → `InProgress` → `Done` → `Archived`.
 * Items may also move to `Blocked` or `WaitingOn` while in progress.
 */
export enum WorkItemState {
  /** Freshly created or accepted from the Inbox; sits in the Queue. */
  New = 'New',
  /** Reviewed and prioritized but not yet started. */
  Triaged = 'Triaged',
  /** Actively being worked on; shown in the Focus view. */
  InProgress = 'InProgress',
  /** Work is stalled on an impediment; shown in the Focus view. */
  Blocked = 'Blocked',
  /** Waiting on an external party; shown in the Focus view. */
  WaitingOn = 'WaitingOn',
  /** Work is complete; shown in History. */
  Done = 'Done',
  /** Removed from active views; retained in History for reference. */
  Archived = 'Archived',
}

/** A persisted work item managed by the WorkGraph. */
export interface WorkItem {
  /** Unique identifier (auto-generated on creation). */
  id: string;
  /** Short display title. */
  title: string;
  /** Optional free-form notes or description. */
  notes?: string;
  /** Current lifecycle state. */
  state: WorkItemState;
  /** ID of the provider that discovered this item, if any. */
  providerId?: string;
  /** Provider-scoped external identifier linking back to the source item. */
  externalId?: string;
  /** URL to the item in its source system. */
  url?: string;
  /** Ordering key within items of the same state. Lower values sort first. */
  sortOrder?: number;
  /** Epoch timestamp (ms) when the item was created. */
  createdAt: number;
  /** Epoch timestamp (ms) of the last modification. */
  updatedAt: number;
}

/** Input required to create or update a work item. */
export interface WorkItemInput {
  /** Short display title. */
  title: string;
  /** Optional free-form notes or description. */
  notes?: string;
}
