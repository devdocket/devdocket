import * as vscode from 'vscode';
import { AiReviewAction } from './aiReviewAction';
import { AiWalkthroughAction } from './aiWalkthroughAction';
import { WalkthroughParticipant } from './walkthroughParticipant';
import { RepoManager } from './repoManager';
import { registerAllTools } from './tools';
import type { WorkCenterApi } from './types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const coreExtension = vscode.extensions.getExtension<WorkCenterApi>('mthalman.workcenter');
  if (!coreExtension) {
    const msg = 'WorkCenter AI Reviewer: core extension not found. Install the WorkCenter extension.';
    console.error(msg);
    vscode.window.showErrorMessage(msg);
    return;
  }

  let api: WorkCenterApi | undefined;
  try {
    api = coreExtension.isActive
      ? coreExtension.exports
      : await coreExtension.activate();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`WorkCenter AI Reviewer: Failed to activate core extension — ${message}`);
    vscode.window.showErrorMessage(`WorkCenter AI Reviewer: Failed to activate core extension — ${message}`);
    return;
  }

  if (!api || typeof api.registerAction !== 'function') {
    const msg = 'WorkCenter AI Reviewer: core extension API not available';
    console.error(msg);
    vscode.window.showErrorMessage(msg);
    return;
  }

  // Register code review action (unchanged)
  const reviewAction = new AiReviewAction();
  context.subscriptions.push(api.registerAction(reviewAction));

  // Set up walkthrough infrastructure
  const repoManager = new RepoManager(context.globalStorageUri);
  const walkthroughAction = new AiWalkthroughAction(repoManager);
  context.subscriptions.push(api.registerAction(walkthroughAction));

  // Register LM tools
  const toolDisposables = registerAllTools();
  toolDisposables.forEach(d => context.subscriptions.push(d));

  // Register chat participant
  const participant = new WalkthroughParticipant(repoManager);
  context.subscriptions.push(participant.register());
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
