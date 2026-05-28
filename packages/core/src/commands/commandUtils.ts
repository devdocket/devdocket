import * as vscode from 'vscode';
import { WorkItemState } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { InboxStateStore, type InboxState } from '../storage/inboxStateStore';
import { logger } from '../services/logger';

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

export function formatItemTitle(item: { group?: string; title: string }): string {
  return item.title;
}

/** Log the error and show a user-facing message. */
export function handleCommandError(context: string, err: unknown): void {
  logger.error(context, err);
  const detail = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(`DevDocket: ${context} — ${detail}`);
}

/** Wrap a command handler so unhandled errors are logged and shown to the user. */
export function wrapCommand<T extends unknown[], R>(label: string, fn: (...args: T) => Promise<R> | R): (...args: T) => Promise<R | undefined> {
  return async (...args: T): Promise<R | undefined> => {
    try {
      return await fn(...args);
    } catch (err: unknown) {
      handleCommandError(label, err);
      return undefined;
    }
  };
}

/**
 * Guard for move commands that require an item to be selected.
 * Shows a hint message if no item (or no id) is provided; otherwise
 * calls the given move operation with the item's id.
 */
export async function requireItemToMove(
  viewName: string,
  item: { id?: string } | undefined,
  fn: (id: string) => Promise<void>,
): Promise<void> {
  if (!item?.id) {
    void vscode.window.showInformationMessage(`DevDocket: Select an item in ${viewName} to move.`);
    return;
  }
  await fn(item.id);
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
): Promise<void> {
  if (ids.length === 1) {
    await workGraph.transitionState(ids[0], targetState);
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
  itemType?: 'issue' | 'pr';
  url?: string;
  group?: string;
}

export async function batchAcceptItems<T extends AcceptableItem>(
  workGraph: WorkGraph,
  stateStore: InboxStateStore,
  items: T[],
  logLabel: string,
): Promise<T[]> {
  let result: Awaited<ReturnType<WorkGraph['acceptManyFromInbox']>>;
  try {
    result = await workGraph.acceptManyFromInbox(items.map(item => ({
      ...item,
      title: formatItemTitle(item),
      group: item.group?.trim() || undefined,
    })));
  } catch (err: unknown) {
    handleCommandError(`Failed to accept ${logLabel}s`, err);
    return [];
  }

  for (const failure of result.failures) {
    logger.error(`Failed to accept ${logLabel} "${failure.input.title}"`, failure.error);
  }

  const acceptedItems = result.accepted.map(accepted => accepted.input as T);
  const stateUpdates: Array<{ providerId: string; externalId: string; state: InboxState }> = acceptedItems.map(item => ({
    providerId: item.providerId,
    externalId: item.externalId,
    state: 'accepted',
  }));

  if (stateUpdates.length > 0) {
    try {
      await stateStore.setStates(stateUpdates);
    } catch (err: unknown) {
      for (const id of result.createdItemIds) {
        try { await workGraph.deleteItem(id); } catch (rollbackErr: unknown) {
          logger.error('Failed to roll back created item after batch setStates failure', rollbackErr);
        }
      }
      for (const { id, originalState } of result.reopenedItems) {
        try { await workGraph.transitionState(id, originalState); } catch (rollbackErr: unknown) {
          logger.error('Failed to roll back re-opened item after batch setStates failure', rollbackErr);
        }
      }
      handleCommandError('Failed to update states after accepting items', err);
      return [];
    }
  }

  const total = stateUpdates.length;
  const failed = result.failures.length;
  if (total > 0) {
    const msg = failed > 0
      ? `Accepted ${total} of ${total + failed} items to Ready to Start`
      : `Accepted ${total} item${total === 1 ? '' : 's'} to Ready to Start`;
    void vscode.window.showInformationMessage(msg);
  }
  if (failed > 0) {
    void vscode.window.showErrorMessage(
      `DevDocket: Failed to accept ${failed} item(s); see Output for details`,
    );
  }

  return acceptedItems;
}
