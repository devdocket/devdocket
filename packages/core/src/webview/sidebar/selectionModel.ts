/**
 * Pure selection model for multi-select on a single tier within the My Work tab.
 *
 * The model is intentionally constrained to a single tier at a time: a click in
 * a different tier replaces the selection wholesale. This dramatically
 * simplifies "valid bulk action" reasoning — every selected item shares the
 * same tier type, so the set of allowed bulk transitions equals the set of
 * allowed transitions for any one of them.
 *
 * Plain click  → clear, then select one (anchor = clicked).
 * Ctrl/Cmd click → toggle membership (anchor = clicked).
 * Shift click  → range-extend from anchor to clicked (anchor unchanged).
 * Escape       → clear.
 *
 * Cross-tier clicks always behave like the "plain" rules above (clear + select
 * one) regardless of modifiers — multi-select never spans tiers.
 */
export interface TierSelection {
  tierId: string;
  itemIds: ReadonlySet<string>;
  anchorId: string;
}

export type SelectionState = TierSelection | null;

export type SelectionModifier = 'none' | 'toggle' | 'range';

export interface TierMembership {
  tierId: string;
  itemIds: readonly string[];
}

/**
 * Apply a click on `itemId` (which belongs to the tier described by
 * `tierMembership`) to `current`. Returns the next selection state.
 *
 * `tierMembership.itemIds` must be the ordered list of item ids currently
 * rendered in the tier — used for range expansion. Items that have since
 * scrolled out of the DOM but are still in the tier model count.
 */
export function applySelectionClick(
  current: SelectionState,
  itemId: string,
  tierMembership: TierMembership,
  modifier: SelectionModifier,
): SelectionState {
  const { tierId, itemIds: tierItemIds } = tierMembership;
  const isSameTier = current?.tierId === tierId;

  if (modifier === 'range' && isSameTier && current) {
    const anchorIndex = tierItemIds.indexOf(current.anchorId);
    const targetIndex = tierItemIds.indexOf(itemId);
    if (anchorIndex < 0 || targetIndex < 0) {
      return selectOne(tierId, itemId);
    }
    const [from, to] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    const range = new Set<string>();
    for (let i = from; i <= to; i++) {
      range.add(tierItemIds[i]);
    }
    return { tierId, itemIds: range, anchorId: current.anchorId };
  }

  if (modifier === 'toggle' && isSameTier && current) {
    const next = new Set(current.itemIds);
    if (next.has(itemId)) {
      next.delete(itemId);
    } else {
      next.add(itemId);
    }
    if (next.size === 0) {
      return null;
    }
    return { tierId, itemIds: next, anchorId: itemId };
  }

  return selectOne(tierId, itemId);
}

export function clearSelection(): SelectionState {
  return null;
}

/**
 * Reconciles a selection state against the latest tier membership. Items
 * that have been removed from the tier (e.g. transitioned away after a bulk
 * action) are dropped from the selection. If the anchor was removed, the
 * remaining first selected item becomes the new anchor. If nothing remains
 * selected, returns null.
 */
export function reconcileSelection(
  current: SelectionState,
  tierMembership: TierMembership | undefined,
): SelectionState {
  if (!current) {
    return null;
  }
  if (!tierMembership || tierMembership.tierId !== current.tierId) {
    return null;
  }
  const present = new Set(tierMembership.itemIds);
  const next = new Set<string>();
  for (const id of current.itemIds) {
    if (present.has(id)) {
      next.add(id);
    }
  }
  if (next.size === 0) {
    return null;
  }
  const anchorId = present.has(current.anchorId)
    ? current.anchorId
    : tierMembership.itemIds.find(id => next.has(id)) ?? current.anchorId;
  // Preserve referential equality when nothing actually changed. Callers
  // (e.g. App.tsx's tier-change effect) feed the result straight into
  // React/Preact state, so allocating a fresh object on every tier update
  // would trigger redundant rerenders.
  if (
    anchorId === current.anchorId &&
    next.size === current.itemIds.size &&
    setsEqual(next, current.itemIds)
  ) {
    return current;
  }
  return { tierId: current.tierId, itemIds: next, anchorId };
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

function selectOne(tierId: string, itemId: string): SelectionState {
  return { tierId, itemIds: new Set([itemId]), anchorId: itemId };
}

/** Tier IDs that support multi-select + bulk transition. Distinct from
 * `ItemCardData['tierType']` (incoming/readyToStart/...); these are the
 * kebab-case identifiers used to address tiers in selection state. */
const MULTI_SELECT_TIER_IDS: ReadonlySet<string> = new Set([
  'ready-to-start',
  'in-progress',
  'paused',
  'done',
]);

export function isMultiSelectTier(tierId: string): boolean {
  return MULTI_SELECT_TIER_IDS.has(tierId);
}
