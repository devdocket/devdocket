import * as vscode from 'vscode';
import { AiReviewAction } from './aiReviewAction';
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

  const action = new AiReviewAction();
  const actionDisposable = api.registerAction(action);
  context.subscriptions.push(actionDisposable);
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
