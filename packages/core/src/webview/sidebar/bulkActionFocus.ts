import type { TierData } from '../shared/types';
import type { SelectionState } from './selectionModel';

/**
 * Identifies what to refocus after a bulk action moves items between tiers.
 *
 * `itemId` is the work item the user is most likely to follow visually
 * after the action — typically the focused selected option, falling back
 * to the first selected item in tier render order. `originTierId` is the
 * tier that owned the selection at action time, used for the fallback
 * chain when the item itself has gone away (e.g. Dismiss removes a card
 * entirely instead of moving it).
 */
export interface PendingBulkFocus {
  itemId: string;
  originTierId: string;
}

/**
 * Pick the work item id that should receive focus after a bulk action.
 *
 * - If the currently focused element is a selected option, prefer its id
 *   (the user is on a specific card, so follow that one).
 * - Otherwise fall back to the first selected item in tier render order
 *   (a stable, predictable choice that doesn't depend on which tier-
 *   internal ordering the selection model produced).
 * - Returns `null` if no usable target exists; callers should skip
 *   pending-focus tracking entirely in that case so an unrelated tiers
 *   re-render can't be misinterpreted as an action result.
 */
export function pickBulkFocusTarget(
  multiSelection: SelectionState,
  tiers: readonly TierData[],
  activeElement: Element | null,
): PendingBulkFocus | null {
  if (!multiSelection || multiSelection.itemIds.size === 0) {
    return null;
  }
  const originTier = tiers.find(tier => tier.id === multiSelection.tierId);
  if (!originTier) {
    return null;
  }
  const orderedSelectedIds = originTier.items
    .map(item => item.id)
    .filter(id => multiSelection.itemIds.has(id));
  if (orderedSelectedIds.length === 0) {
    return null;
  }
  // Prefer the focused option if it's part of the selection — that's the
  // user's visual anchor at the moment of activation. Anchored on
  // `data-item-id` rather than aria-selected so the lookup matches the
  // attribute we add to ItemCard.
  if (activeElement instanceof HTMLElement) {
    const focusedItemId = activeElement.closest('[data-item-id]')?.getAttribute('data-item-id');
    if (focusedItemId && multiSelection.itemIds.has(focusedItemId)) {
      return { itemId: focusedItemId, originTierId: multiSelection.tierId };
    }
  }
  return { itemId: orderedSelectedIds[0], originTierId: multiSelection.tierId };
}

/**
 * Decide whether the App-level pending bulk focus has been satisfied by
 * the latest `tiers` snapshot. We only consider the pending state
 * actionable once the snapshot actually reflects the bulk action:
 * specifically, the target item is no longer in its origin tier. This
 * stops an UNRELATED `updateItems` push (e.g. a provider refresh during
 * extension latency) from prematurely consuming the pending state and
 * stranding focus on `document.body`.
 *
 * Returns `true` if the effect should proceed with restoration; `false`
 * if it should keep waiting for a later tiers update.
 */
export function bulkActionHasLanded(pending: PendingBulkFocus, tiers: readonly TierData[]): boolean {
  const originTier = tiers.find(tier => tier.id === pending.originTierId);
  if (!originTier) {
    return true;
  }
  return !originTier.items.some(item => item.id === pending.itemId);
}

/**
 * Resolve the actual DOM element to focus after a bulk action lands.
 *
 * Order of preference:
 *   1. The actioned item itself in any tier (most useful — the user
 *      follows the card to its new home).
 *   2. The tier header button of the tier the item ended up in (the
 *      item exists in the model but is hidden by collapse/filter).
 *   3. The tier header button of the originating tier (item is gone
 *      entirely, but the origin tier is still a meaningful neighborhood).
 *   4. The My Work tab itself (last-resort focusable control in the
 *      same logical region).
 *
 * Listboxes and tabpanels are intentionally NOT used as fallbacks
 * because they have no `tabIndex` and `.focus()` would silently no-op,
 * leaving the user on `document.body`.
 */
export function resolveBulkFocusTarget(
  pending: PendingBulkFocus,
  tiers: readonly TierData[],
  root: ParentNode,
): HTMLElement | null {
  const escapedItemId = escapeAttributeSelector(pending.itemId);
  const itemNode = root.querySelector<HTMLElement>(`[data-item-id="${escapedItemId}"]`);
  if (itemNode) {
    return itemNode;
  }
  const destinationTier = tiers.find(tier => tier.items.some(item => item.id === pending.itemId));
  const destinationHeader = destinationTier
    ? root.querySelector<HTMLElement>(
        `[data-tier-id="${escapeAttributeSelector(destinationTier.id)}"] [data-tier-header="true"]`,
      )
    : null;
  if (destinationHeader) {
    return destinationHeader;
  }
  const originHeader = root.querySelector<HTMLElement>(
    `[data-tier-id="${escapeAttributeSelector(pending.originTierId)}"] [data-tier-header="true"]`,
  );
  if (originHeader) {
    return originHeader;
  }
  return root.querySelector<HTMLElement>('#mission-control-tab-my-work');
}

/**
 * Decide whether the App-level restore should run, given the current
 * activeElement. We only restore when focus has clearly been lost (the
 * usual post-bulk-action state, where the focused button was removed
 * with the bar and the browser fell back to `body`) OR when focus has
 * landed on the about-to-be-removed origin item (e.g. `BulkActionBar`'s
 * own cleanup placed focus there as a stopgap). Any other focused
 * element means the user has navigated away on purpose and we must not
 * steal focus back.
 */
export function shouldRestoreBulkFocus(pending: PendingBulkFocus, activeElement: Element | null): boolean {
  if (activeElement === null || activeElement === document.body) {
    return true;
  }
  if (activeElement instanceof HTMLElement) {
    const activeItemId = activeElement.closest('[data-item-id]')?.getAttribute('data-item-id');
    if (activeItemId === pending.itemId) {
      return true;
    }
  }
  return false;
}

function escapeAttributeSelector(value: string): string {
  // Prefer the browser's `CSS.escape` when available (always present in
  // Chromium and in modern jsdom). Fall back to a hand-roll that escapes
  // the characters that matter inside a quoted attribute-value selector —
  // double-quotes and backslashes — so we still produce a valid selector
  // for the (currently unseen) case of an item id containing those.
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}
