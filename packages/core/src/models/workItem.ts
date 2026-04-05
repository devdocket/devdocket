/**
 * Lifecycle states for a {@link WorkItem}.
 *
 * Items move through these states following the work-item state machine:
 *
 * ```
 * New → Triaged → InProgress → Done → Archived
 *                   ↕    ↕
 *               Blocked  WaitingOn
 * ```
 */
export enum WorkItemState {
  /** Freshly created item that has not yet been triaged. */
  New = 'New',
  /** Item has been reviewed and accepted into the queue. */
  Triaged = 'Triaged',
  /** Item is actively being worked on (appears in Focus view). */
  InProgress = 'InProgress',
  /** Work is blocked by an impediment (appears in Focus view). */
  Blocked = 'Blocked',
  /** Waiting on an external party or event (appears in Focus view). */
  WaitingOn = 'WaitingOn',
  /** Work is complete (appears in History view). */
  Done = 'Done',
  /** Item has been archived and hidden from the default History view. */
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
  /** Unique identifier (UUID) for this work item. */
  id: string;
  /** Short human-readable title displayed in tree views. */
  title: string;
  /** Optional free-form notes or description entered by the user. */
  notes?: string;
  /** Current lifecycle state of the work item. */
  state: WorkItemState;
  /** Identifier of the provider that originally discovered this item, if any. */
  providerId?: string;
  /** Provider-scoped identifier used to correlate with {@link DiscoveredItem.externalId}. */
  externalId?: string;
  /** URL linking to the external resource (e.g. GitHub issue page). */
  url?: string;
  /** Position within the queue for manual ordering. Lower values appear first. */
  sortOrder?: number;
  /** Unix epoch timestamp (ms) of when the item was created. */
  createdAt: number;
  /** Unix epoch timestamp (ms) of the last state or content change. */
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
