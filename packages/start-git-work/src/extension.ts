import * as vscode from 'vscode';
import { StartWorkAction } from './startWorkAction';
import { promptGitCleanup } from './gitCleanup';
import { logger, setLogger } from './logger';
import type { StateTransitionEvent, ActivityType } from '@devdocket/shared';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('DevDocket Start Git Work', { log: true });
  context.subscriptions.push(log);
  setLogger(log);

  log.info('DevDocket Start Git Work activating...');

  const coreExtension = vscode.extensions.getExtension('mthalman.devdocket');
  if (!coreExtension) {
    logger.error('Core extension not found');
    return;
  }

  let api;
  try {
    api = coreExtension.isActive ? coreExtension.exports : await coreExtension.activate();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to activate core extension — ${message}`);
    void vscode.window.showErrorMessage(`DevDocket Start Git Work: Failed to activate core extension — ${message}`);
    return;
  }

  if (!api || typeof api.registerAction !== 'function') {
    logger.error('Core extension API not available');
    return;
  }

  const startWorkAction = new StartWorkAction(context.globalState);
  const actionDisposable = api.registerAction(startWorkAction);
  context.subscriptions.push(actionDisposable);

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
