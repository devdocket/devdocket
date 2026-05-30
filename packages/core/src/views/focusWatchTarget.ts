/**
 * Identifies a specific watch row that should be scrolled into view in the
 * CI Watches panel after it opens. Plumbed from the sidebar/editor "open
 * watches" affordances so the panel can highlight the row that matches the
 * item the user clicked from.
 */
export interface FocusWatchTarget {
  /** Work item id (preferred when the click originated from a work-item card). */
  focusItemId?: string;
  /** Provider id of the underlying provider item (used for Incoming-tier items). */
  focusProviderId?: string;
  /** External id of the underlying provider item. */
  focusExternalId?: string;
}

/**
 * Build a {@link FocusWatchTarget} from an `openWatches` webview message,
 * returning `undefined` when no identity is supplied (in which case the
 * panel should open without focusing any row).
 */
export function buildFocusWatchTarget(
  message: { focusItemId?: unknown; focusProviderId?: unknown; focusExternalId?: unknown },
): FocusWatchTarget | undefined {
  const focusItemId = typeof message.focusItemId === 'string' && message.focusItemId.length > 0
    ? message.focusItemId
    : undefined;
  const focusProviderId = typeof message.focusProviderId === 'string' && message.focusProviderId.length > 0
    ? message.focusProviderId
    : undefined;
  const focusExternalId = typeof message.focusExternalId === 'string' && message.focusExternalId.length > 0
    ? message.focusExternalId
    : undefined;
  if (!focusItemId && !(focusProviderId && focusExternalId)) {
    return undefined;
  }
  const target: FocusWatchTarget = {};
  if (focusItemId) target.focusItemId = focusItemId;
  if (focusProviderId) target.focusProviderId = focusProviderId;
  if (focusExternalId) target.focusExternalId = focusExternalId;
  return target;
}

/**
 * Defensive coercion for command arguments: the `devdocket.showWatchesQuickPick`
 * command accepts an optional focus target. Returns `undefined` when the input
 * isn't a recognisable target (e.g. command palette invocation passes nothing).
 */
export function coerceFocusWatchTarget(input: unknown): FocusWatchTarget | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  return buildFocusWatchTarget(input as { focusItemId?: unknown; focusProviderId?: unknown; focusExternalId?: unknown });
}
