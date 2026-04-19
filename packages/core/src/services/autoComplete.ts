import * as vscode from 'vscode';
import { WorkGraph } from './workGraph';
import { WorkItemState } from '../models/workItem';
import { ProviderRegistry } from './providerRegistry';
import { logger } from './logger';

/** Work item states eligible for auto-completion when the external item is closed/merged. */
export const AUTO_COMPLETABLE_STATES: ReadonlySet<WorkItemState> = new Set([WorkItemState.New, WorkItemState.InProgress, WorkItemState.Paused]);

/**
 * Check for work items that should be auto-completed after a provider refresh.
 *
 * Scans the full WorkGraph for items linked to the given provider — covering both
 * provider-discovered and manually-imported items. Uses the provider's
 * `getClosedItems()` for batch status checks when available; otherwise falls back
 * to disappearance detection (item was previously discovered but is now absent).
 *
 * @returns Titles of items that were transitioned to Done, for notification purposes.
 */
export async function checkAutoComplete(
  providerId: string,
  workGraph: WorkGraph,
  providerRegistry: ProviderRegistry,
  signal?: AbortSignal,
): Promise<string[]> {
  // Collect all work items linked to this provider in auto-completable states
  const candidates = workGraph.getAll().filter(
    item => item.providerId === providerId && item.externalId && AUTO_COMPLETABLE_STATES.has(item.state),
  );
  if (candidates.length === 0) {
    return [];
  }

  let closedIds: Set<string>;
  const provider = providerRegistry.getProvider(providerId);

  if (provider && typeof provider.getClosedItems === 'function') {
    // Provider supports batch status checks — covers imported items too
    try {
      const externalIds = [...new Set(candidates.map(item => item.externalId!))];
      const result = await provider.getClosedItems(externalIds, signal);
      if (signal?.aborted) { return []; }
      closedIds = new Set(result);
    } catch (err) {
      if (signal?.aborted) { return []; }
      logger.error(`Provider "${providerId}" getClosedItems failed, skipping auto-complete`, err);
      return [];
    }
  } else {
    // Fallback: compare current vs previous discovered items.
    // Only items that were previously discovered and are now absent are considered closed.
    // This avoids false positives for imported items that the provider never tracked.
    if (providerRegistry.wasLastRefreshTruncated(providerId)) {
      return [];
    }
    const currentItems = providerRegistry.getDiscoveredItems(providerId);
    // Guard: if the provider returned zero items, skip auto-complete. Zero items could
    // indicate a transient API failure or auth error rather than all items being closed.
    // Providers that need to handle the "all items closed" case should implement
    // getClosedItems() for explicit status checking.
    if (currentItems.length === 0) {
      return [];
    }
    const currentIds = new Set(currentItems.map(i => i.externalId));
    closedIds = new Set<string>();
    for (const item of candidates) {
      if (
        !currentIds.has(item.externalId!) &&
        providerRegistry.wasItemPreviouslyDiscovered(providerId, item.externalId!)
      ) {
        closedIds.add(item.externalId!);
      }
    }
  }

  const completedTitles: string[] = [];
  for (const item of candidates) {
    if (signal?.aborted) { break; }
    if (closedIds.has(item.externalId!)) {
      const currentItem = workGraph.getItem(item.id);
      if (!currentItem || !currentItem.externalId || !AUTO_COMPLETABLE_STATES.has(currentItem.state)) {
        continue;
      }
      try {
        await workGraph.transitionState(currentItem.id, WorkItemState.Done);
        await workGraph.addActivity(currentItem.id, 'auto-completed', `Provider detected external closure (${currentItem.state} → Done)`);
        completedTitles.push(currentItem.title);
        logger.info(`Auto-completed work item "${currentItem.title}" (${currentItem.id}) — external item closed/merged`);
      } catch (err) {
        logger.error(`Failed to auto-complete work item ${currentItem.id}`, err);
      }
    }
  }

  return completedTitles;
}

/**
 * Show a notification summarising auto-completed items with a "Show History" action.
 */
export function showAutoCompleteNotification(completedTitles: string[]): void {
  if (completedTitles.length === 0) {
    return;
  }
  const message = completedTitles.length === 1
    ? `Item completed: ${completedTitles[0]} was closed/merged externally`
    : `${completedTitles.length} items completed — closed/merged externally`;
  void vscode.window.showInformationMessage(`DevDocket: ${message}`, 'Show History').then(
    action => {
      if (action === 'Show History') {
        vscode.commands.executeCommand('devdocket.history.focus').then(
          undefined,
          () => { /* view focus is best-effort */ },
        );
      }
    },
    () => { /* notification is best-effort */ },
  );
}
