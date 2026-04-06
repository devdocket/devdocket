/**
 * Lifecycle states for a {@link WorkItem}.
 *
 * Items move throughthese states following the work-item state machine:
 *
 * ```
 * New → Triaged → InProgress → Done → Archived
 *                   ↕    ↕
 *               Blocked  WaitingOn
 * ```
 *
 * `Triaged` is reserved for future use and is not currently used in the UI flow.
 */
export enum WorkItemState {
  /** Freshly created or accepted from the Inbox; sits in the Queue. */
  New = 'New',
  /** Reserved for future use; not currently used in the UI flow. */
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

/**
 * A persisted work item managed by WorkCenter.
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
  /** Provider-scoped identifier used to correlate with {@link DiscoveredItem.externalId}. */
  externalId?: string;
  /** URL to the item in its source system (e.g. GitHub issue page). */
  url?: string;
  /** Ordering key within items of the same state. Lower values sort first. */
  sortOrder?: number;
  /** Epoch timestamp (ms) when the item was created. */
  createdAt: number;
  /** Epoch timestamp (ms) of the last modification. */
  updatedAt: number;
}

/**
 * Input payload for creating a new work item manually (without a provider).
 *
 * @example
 * ```ts
 * const input: WorkItemInput = {
 *   title: 'Fix login bug',
 *   notes: 'Users report intermittent 401 errors on the /auth endpoint.',
 * };
 * ```
 */
export interface WorkItemInput {
  /** Short human-readable title for the new work item. */
  title: string;
  /** Optional free-form notes or description. */
  notes?: string;
}
