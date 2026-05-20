import * as vscode from 'vscode';
import { AiReviewAction } from './aiReviewAction';
import { AiWalkthroughAction } from './aiWalkthroughAction';
import { WalkthroughParticipant } from './walkthroughParticipant';
import { RepoManager } from './repoManager';
import { registerAllTools } from './tools';
import type { DevDocketApi } from './types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('DevDocket AI Reviewer', { log: true });
  context.subscriptions.push(log);

  log.info('Activating DevDocket AI Reviewer extension');

  const coreExtension = vscode.extensions.getExtension<DevDocketApi>('devdocket.devdocket');
  if (!coreExtension) {
    const msg = 'DevDocket AI Reviewer: core extension not found. Install the DevDocket extension.';
    log.error(msg);
    console.error(msg);
    vscode.window.showErrorMessage(msg);
    return;
  }

  const api = coreExtension.exports as DevDocketApi;

  if (!api || typeof api.registerAction !== 'function') {
    const msg = 'DevDocket AI Reviewer: core extension API not available';
    log.error(msg);
    console.error(msg);
    vscode.window.showErrorMessage(msg);
    return;
  }

  // Shared infrastructure for both actions
  const repoManager = new RepoManager(context.globalStorageUri, log);

  // Register code review action (uses shared RepoManager)
  const reviewAction = new AiReviewAction(repoManager, log);
  context.subscriptions.push(api.registerAction(reviewAction));
  log.info('Registered AI Code Review action');

  // Register walkthrough action (uses shared RepoManager)
  const walkthroughAction = new AiWalkthroughAction(repoManager, log);
  context.subscriptions.push(api.registerAction(walkthroughAction));
  log.info('Registered AI Walkthrough action');

  // Register LM tools
  const toolDisposables = registerAllTools();
  toolDisposables.forEach(d => context.subscriptions.push(d));
  log.info(`Registered ${toolDisposables.length} LM tools`);

  // Register chat participant (uses shared RepoManager)
  const participant = new WalkthroughParticipant(repoManager, log);
  context.subscriptions.push(participant.register());
  log.info('Registered @walkthrough chat participant');

  log.info('DevDocket AI Reviewer activation complete');
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
