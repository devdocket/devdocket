// Canonical type declarations live in @devdocket/shared; re-export for
// existing intra-core imports.
export type { ActivityType, ActivityLogEntry } from '@devdocket/shared';
import type { ActivityType } from '@devdocket/shared';

/**
 * Maximum number of activity log entries retained per work item.
 * When the log exceeds this limit, the oldest entries are trimmed.
 */
export const MAX_ACTIVITY_LOG_ENTRIES = 100;

/** All valid activity type values, for runtime validation. */
export const ACTIVITY_TYPES = ['created', 'state-changed', 'updated', 'action-executed', 'auto-completed', 'work-started', 'cleanup', 'cleanup-dismissed'] as const satisfies readonly ActivityType[];
