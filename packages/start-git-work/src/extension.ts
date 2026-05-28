import * as vscode from 'vscode';
import { StartWorkAction } from './startWorkAction';
import { promptGitCleanup } from './gitCleanup';
import { decodeWorkStartedDetail, renderWorkStartedActivityDetail } from './workStartedDetail';
import { logger, setLogger } from './logger';
import type { StateTransitionEvent, ActivityType, DevDocketApi, GitWorkAssociation, WorkItem } from '@devdocket/shared';

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

  // Register the git-work resolver. Same encapsulation principle as the
  // activity-detail renderer: we expose the latest decoded branch/worktree
  // for a work item without forcing the core extension to parse the
  // versioned 'work-started' detail schema.
  if (typeof api.registerGitWorkResolver === 'function') {
    try {
      const resolverDisposable = api.registerGitWorkResolver(resolveGitWorkForItem);
      context.subscriptions.push(resolverDisposable);
    } catch (err) {
      logger.warn('Failed to register git-work resolver', err);
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

/**
 * Resolver passed to {@link DevDocketApi.registerGitWorkResolver}: walks the
 * work item's activity log in reverse for the most recent `'work-started'`
 * entry, decodes its payload via the versioned {@link decodeWorkStartedDetail}
 * helper, and returns the derived branch / worktree pair.
 *
 * Returns `undefined` when no entry exists or the latest entry decodes to a
 * payload without either a branch name or a worktree path — the core UI uses
 * `undefined` as the signal to hide the branch badge entirely.
 *
 * Exported for unit testing; the public consumer is the resolver registration
 * in {@link activate}.
 */
export function resolveGitWorkForItem(item: Readonly<WorkItem>): GitWorkAssociation | undefined {
  const log = item.activityLog;
  if (!log || log.length === 0) {
    return undefined;
  }

  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.type !== 'work-started') {
      continue;
    }

    const decoded = decodeWorkStartedDetail(entry.detail);
    if (!decoded) {
      return undefined;
    }
    if (!decoded.branchName && !decoded.worktreePath) {
      return undefined;
    }
    return {
      ...(decoded.branchName ? { branch: decoded.branchName } : {}),
      ...(decoded.worktreePath ? { worktreePath: decoded.worktreePath } : {}),
    };
  }

  return undefined;
}
