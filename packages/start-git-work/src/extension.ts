import * as vscode from 'vscode';
import { StartWorkAction } from './startWorkAction';
import { promptGitCleanup } from './gitCleanup';
import { renderWorkStartedActivityDetail } from './workStartedDetail';
import { logger, setLogger } from './logger';
import type { StateTransitionEvent, ActivityType, DevDocketApi } from '@devdocket/shared';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('DevDocket Start Git Work', { log: true });
  context.subscriptions.push(log);
  setLogger(log);

  log.info('DevDocket Start Git Work activating...');

  const coreExtension = vscode.extensions.getExtension('devdocket.devdocket');
  if (!coreExtension) {
    logger.error('Core extension devdocket.devdocket not found. Install or enable DevDocket.');
    return;
  }

  const api = coreExtension.exports as DevDocketApi;

  if (!api || typeof api.registerAction !== 'function') {
    logger.error('Core extension API not available');
    return;
  }

  const startWorkAction = new StartWorkAction(
    context.globalState,
    (providerId, externalId) => api.getProviderItem?.(providerId, externalId),
  );
  const actionDisposable = api.registerAction(startWorkAction);
  context.subscriptions.push(actionDisposable);

  // Register the activity-detail renderer for our 'work-started' entries.
  // The core extension uses this to render entries without parsing the
  // schema itself, keeping the cross-package contract one-directional
  // (we own the schema, the encoder, the decoder, and the renderer).
  if (typeof api.registerActivityDetailRenderer === 'function') {
    try {
      const rendererDisposable = api.registerActivityDetailRenderer('work-started', renderWorkStartedActivityDetail);
      context.subscriptions.push(rendererDisposable);
    } catch (err) {
      logger.warn('Failed to register work-started activity detail renderer', err);
    }
  }

  // Listen for Done transitions to prompt for branch/worktree cleanup
  if (typeof api.onDidTransitionState === 'function') {
    const cleanupDisposable = api.onDidTransitionState((event: StateTransitionEvent) => {
      if (event.newState === 'Done') {
        const addActivity = async (itemId: string, type: ActivityType, detail?: string) => {
          if (typeof api.addActivity === 'function') {
            await api.addActivity(itemId, type, detail);
          }
        };
        void promptGitCleanup(event.item, addActivity).catch(err => {
          logger.error('Failed to run git cleanup prompt', err);
        });
      }
    });
    context.subscriptions.push(cleanupDisposable);
  }

  logger.info('DevDocket Start Git Work activated');
}

export function deactivate(): void {
  logger.info('DevDocket Start Git Work deactivated');
}
