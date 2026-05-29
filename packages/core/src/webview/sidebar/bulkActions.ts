import type { ItemCardData } from '../shared/types';

export interface BulkAction {
  id: string;
  label: string;
  icon: string;
  /** Target WorkItemState string value (e.g. 'InProgress', 'Done'). */
  targetState: string;
}

interface TierBulkConfig {
  /** Actions available for any item in this tier. */
  actions: readonly BulkAction[];
}

/**
 * Bulk actions per tier. The action set mirrors the per-item action set in
 * `ItemCard.getItemActions` so users see the same vocabulary in both places.
 * Only tiers backed by a WorkItem state are listed — Incoming items have no
 * concept of `transitionState`, so multi-select / bulk-transition is
 * deliberately not offered there.
 */
const BULK_ACTIONS_BY_TIER: Record<ItemCardData['tierType'], TierBulkConfig | undefined> = {
  incoming: undefined,
  readyToStart: {
    actions: [
      { id: 'start', icon: '▶', label: 'Start', targetState: 'InProgress' },
      { id: 'pause', icon: '⏸', label: 'Pause', targetState: 'Paused' },
    ],
  },
  inProgress: {
    actions: [
      { id: 'complete', icon: '✓', label: 'Complete', targetState: 'Done' },
      { id: 'pause', icon: '⏸', label: 'Pause', targetState: 'Paused' },
    ],
  },
  paused: {
    actions: [
      { id: 'resume', icon: '▶', label: 'Resume', targetState: 'InProgress' },
    ],
  },
  done: {
    actions: [
      { id: 'requeue', icon: '↩', label: 'Requeue', targetState: 'New' },
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

  // Defensive: cross-tier selection (shouldn't happen). Return action IDs
  // present in every selected item's tier config.
  const actionIdSets = items.map(item => {
    const config = BULK_ACTIONS_BY_TIER[item.tierType];
    return new Set(config?.actions.map(a => a.id) ?? []);
  });
  return firstConfig.actions.filter(action =>
    actionIdSets.every(set => set.has(action.id)),
  );
}
