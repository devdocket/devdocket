import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { DiscoveredStateStore, type InboxState } from '../storage/discoveredStateStore';
import { logger } from '../services/logger';
import type { ViewRevealer } from '../services/viewRevealer';

/**
 * Resolves item IDs from VS Code multi-select args for WorkItem-based views.
 * Falls back to the single context item when the filtered selection is empty or
 * does not include the right-clicked item.
 */
export function resolveItemIds(item?: { id?: string }, selectedItems?: { id?: string }[]): string[] {
  if (selectedItems && selectedItems.length > 0) {
    const filtered = selectedItems.map(i => i?.id).filter((id): id is string => !!id);
    if (filtered.length > 0 && (!item?.id || filtered.includes(item.id))) {
      return filtered;
    }
  }
  if (item?.id) {
    return [item.id];
  }
  return [];
}

/** Builds a work-item title, optionally prefixed with the provider group. */
export function formatItemTitle(item: { group?: string; title: string }): string {
  const trimmedGroup = item.group?.trim();
  return trimmedGroup ? `${trimmedGroup} ${item.title}` : item.title;
}

/** Log the error and show a user-facing message. */
export function handleCommandError(context: string, err: unknown): void {
  logger.error(context, err);
  const detail = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(`DevDocket: ${context} — ${detail}`);
}

/** Wrap a command handler so unhandled errors are logged and shown to the user. */
export function wrapCommand<T extends unknown[]>(label: string, fn: (...args: T) => Promise<void> | void): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (err: unknown) {
      handleCommandError(label, err);
    }
  };
}

/**
 * Transitions multiple items to a target state. Single items use the direct
 * path (errors bubble to wrapCommand). Batches continue on individual failures
 * and show a summary message.
 */
export async function batchTransition(
  workGraph: WorkGraph,
  ids: string[],
  targetState: WorkItemState,
  successMessage: (count: number) => string,
  revealer?: ViewRevealer,
): Promise<void> {
  if (ids.length === 1) {
    await workGraph.transitionState(ids[0], targetState);
    void revealer?.revealByState(ids[0]);
    return;
  }
  const failedIds: string[] = [];
  for (const id of ids) {
    try {
      await workGraph.transitionState(id, targetState);
    } catch (err: unknown) {
      failedIds.push(id);
      logger.error(`Failed to transition item ${id}`, err);
    }
  }
  const succeeded = ids.length - failedIds.length;
  if (succeeded > 0) {
    void vscode.window.showInformationMessage(successMessage(succeeded));
  }
  if (failedIds.length > 0) {
    void vscode.window.showErrorMessage(
      `DevDocket: Failed to transition ${failedIds.length} item(s); see Output for details`,
    );
  }
}

/** Shared logic for batch-accepting discovered items (Inbox or Sources). */
export interface AcceptableItem {
  providerId: string;
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  group?: string;
}

export async function batchAcceptItems(
  workGraph: WorkGraph,
  stateStore: DiscoveredStateStore,
  items: AcceptableItem[],
  logLabel: string,
): Promise<void> {
  const stateUpdates: Array<{ providerId: string; externalId: string; state: InboxState }> = [];
  const createdIds: string[] = [];
  // Track re-opened items so we can roll back on setStates failure
  const reopenedItems: Array<{ id: string; originalState: WorkItemState }> = [];
  let failed = 0;

  for (const item of items) {
    const existing = workGraph.findItemByProvenance(item.providerId, item.externalId);
    if (existing) {
      // Re-open items in terminal states so resurfaced items return to Queue
      if (existing.state === WorkItemState.Done || existing.state === WorkItemState.Archived) {
        const originalState = existing.state;
        try {
          await workGraph.transitionState(existing.id, WorkItemState.New);
          reopenedItems.push({ id: existing.id, originalState });
        } catch (err: unknown) {
          failed++;
          logger.error(`Failed to re-open ${logLabel} "${item.title}"`, err);
          continue;
        }
      }
      stateUpdates.push({ providerId: item.providerId, externalId: item.externalId, state: 'accepted' });
      continue;
    }
    try {
      const createdItem = await workGraph.createItem(
        { title: formatItemTitle(item), description: item.description },
        { providerId: item.providerId, externalId: item.externalId, url: item.url, group: item.group?.trim() || undefined },
      );
      createdIds.push(createdItem.id);
      stateUpdates.push({ providerId: item.providerId, externalId: item.externalId, state: 'accepted' });
    } catch (err: unknown) {
      failed++;
      logger.error(`Failed to accept ${logLabel} "${item.title}"`, err);
    }
  }

  if (stateUpdates.length > 0) {
    try {
      await stateStore.setStates(stateUpdates);
    } catch (err: unknown) {
      for (const id of createdIds) {
        try { await workGraph.deleteItem(id); } catch (rollbackErr: unknown) {
          logger.error('Failed to roll back created item after batch setStates failure', rollbackErr);
        }
      }
      for (const { id, originalState } of reopenedItems) {
        try { await workGraph.transitionState(id, originalState); } catch (rollbackErr: unknown) {
          logger.error('Failed to roll back re-opened item after batch setStates failure', rollbackErr);
        }
      }
      handleCommandError('Failed to update states after accepting items', err);
      return;
    }
  }

  const total = stateUpdates.length;
  if (total > 0) {
    const msg = failed > 0
      ? `Accepted ${total} of ${total + failed} items to Queue`
      : `Accepted ${total} item${total === 1 ? '' : 's'} to Queue`;
    void vscode.window.showInformationMessage(msg);
  }
  if (failed > 0) {
    void vscode.window.showErrorMessage(
      `DevDocket: Failed to accept ${failed} item(s); see Output for details`,
    );
  }
}
