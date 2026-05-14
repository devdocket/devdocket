import * as vscode from 'vscode';
import type { InboxStateStore } from '../storage/inboxStateStore';
import { logger } from '../services/logger';

const UNDO_ACTION = 'Undo';

export function showDismissUndoMessage(
  stateStore: Pick<InboxStateStore, 'setState'>,
  providerId: string,
  externalId: string,
  title: string,
): void {
  void (async () => {
    let selection: string | undefined;
    try {
      selection = await vscode.window.showInformationMessage(`Dismissed "${title}"`, UNDO_ACTION);
    } catch (err) {
      logger.error('DevDocket: dismiss undo notification failed', err);
      return;
    }

    if (selection !== UNDO_ACTION) {
      return;
    }

    try {
      await stateStore.setState(providerId, externalId, 'unseen');
    } catch (err) {
      logger.error('DevDocket: dismiss undo failed', err);
      void vscode.window.showErrorMessage(`Failed to restore item: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}
