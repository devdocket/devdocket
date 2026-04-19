/**
 * Maximum number of activity log entries retained per work item.
 * When the log exceeds this limit, the oldest entries are trimmed.
 */
export const MAX_ACTIVITY_LOG_ENTRIES = 100;

/**
 * Discriminated activity types tracked in the work item activity log.
 *
 * - `created` — item was created (manual or from provider).
 * - `state-changed` — lifecycle state transition.
 * - `updated` — user edited title or notes.
 * - `action-executed` — an extension-defined action was run.
 */
export type ActivityType = 'created' | 'state-changed' | 'updated' | 'action-executed';

/**
 * A single, immutable entry in a work item's activity log.
 *
 * Entries are append-only; the log is trimmed from the front when
 * {@link MAX_ACTIVITY_LOG_ENTRIES} is exceeded.
 */
export interface ActivityLogEntry {
  /** Epoch timestamp (ms) when the activity occurred. */
  timestamp: number;
  /** The kind of activity. */
  type: ActivityType;
  /** Optional human-readable detail (e.g. "New → InProgress"). */
  detail?: string;
}
