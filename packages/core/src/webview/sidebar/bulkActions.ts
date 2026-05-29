import type { ItemCardData } from '../shared/types';

interface BulkActionBase {
  id: string;
  label: string;
  icon: string;
}

/**
 * A bulk action attached to one or more selected cards. Two kinds:
 *
 * - `transition`: a WorkItem state transition (Start, Pause, Resume, Complete,
 *   Requeue). The host routes these through `WorkGraph.transitionState` /
 *   `resumeItem`.
 * - `inbox`: an inbox-state mutation for provider items in the Incoming tier
 *   (Accept or Dismiss). The host routes these through the same batched
 *   accept-from-inbox / setStates paths used by the Accept All button and the
 *   single-item Accept/Dismiss controls.
 */
export type BulkAction =
  | (BulkActionBase & { kind: 'transition'; targetState: string })
  | (BulkActionBase & { kind: 'inbox'; inboxAction: 'accept' | 'dismiss' });

interface TierBulkConfig {
  /** Actions available for any item in this tier. */
  actions: readonly BulkAction[];
}

/**
 * Bulk actions per tier. The action set mirrors the per-item action set in
 * `ItemCard.getItemActions` so users see the same vocabulary in both places.
 *
 * The Incoming tier maps to inbox-state mutations (Accept / Dismiss) — those
 * items are provider references, not WorkItems, so they have no concept of
 * `transitionState`. Every other tier maps to WorkItem state transitions.
 */
const BULK_ACTIONS_BY_TIER: Record<ItemCardData['tierType'], TierBulkConfig | undefined> = {
  incoming: {
    actions: [
      { id: 'accept', icon: '✓', label: 'Accept', kind: 'inbox', inboxAction: 'accept' },
      { id: 'dismiss', icon: '✕', label: 'Dismiss', kind: 'inbox', inboxAction: 'dismiss' },
    ],
  },
  readyToStart: {
    actions: [
      { id: 'start', icon: '▶', label: 'Start', kind: 'transition', targetState: 'InProgress' },
      { id: 'pause', icon: '⏸', label: 'Pause', kind: 'transition', targetState: 'Paused' },
    ],
  },
  inProgress: {
    actions: [
      { id: 'complete', icon: '✓', label: 'Complete', kind: 'transition', targetState: 'Done' },
      { id: 'pause', icon: '⏸', label: 'Pause', kind: 'transition', targetState: 'Paused' },
    ],
  },
  paused: {
    actions: [
      { id: 'resume', icon: '▶', label: 'Resume', kind: 'transition', targetState: 'InProgress' },
    ],
  },
  done: {
    actions: [
      { id: 'requeue', icon: '↩', label: 'Requeue', kind: 'transition', targetState: 'New' },
    ],
  },
};

/**
 * Compute the bulk actions available for `items`. Because multi-select is
 * always constrained to a single tier (see {@link applySelectionClick}), all
 * items share the same `tierType` and the intersection collapses to the
 * tier-level action set. If items somehow have mixed tierTypes (defensive
 * branch — should not happen in normal flow), the intersection of action IDs
 * is returned so the bar only shows actions that are valid for every item.
 */
export function getBulkActionsForItems(items: readonly ItemCardData[]): readonly BulkAction[] {
  if (items.length === 0) {
    return [];
  }

  const firstConfig = BULK_ACTIONS_BY_TIER[items[0].tierType];
  if (!firstConfig) {
    return [];
  }

  const allSameTier = items.every(item => item.tierType === items[0].tierType);
  if (allSameTier) {
    return firstConfig.actions;
  }

  // Defensive: cross-tier selection (shouldn't happen). Return actions whose
  // id is present in every selected item's tier config.
  const actionIdSets = items.map(item => {
    const config = BULK_ACTIONS_BY_TIER[item.tierType];
    return new Set(config?.actions.map(a => a.id) ?? []);
  });
  return firstConfig.actions.filter(action =>
    actionIdSets.every(set => set.has(action.id)),
  );
}
