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
export const ACTIVITY_TYPES = ['created', 'state-changed', 'updated', 'action-executed', 'auto-completed', 'work-started', 'cleanup', 'cleanup-dismissed', 'version-updated'] as const satisfies readonly ActivityType[];

// Compile-time exhaustiveness check: fails if a new ActivityType is added to
// @devdocket/shared without updating ACTIVITY_TYPES above.
type _MissingActivityTypes = Exclude<ActivityType, (typeof ACTIVITY_TYPES)[number]>;
const _assertAllActivityTypesCovered: _MissingActivityTypes extends never ? true : never = true;
void _assertAllActivityTypesCovered;
