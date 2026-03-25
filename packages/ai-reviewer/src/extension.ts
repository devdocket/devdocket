import * as vscode from 'vscode';
import { AiReviewAction } from './aiReviewAction';

// Re-declared to match core API contract — separate extension cannot import core types directly
interface Disposable {
  dispose(): void;
}

interface WorkItem {
  id: string;
  title: string;
  description?: string;
  state: string;
  providerId?: string;
  externalId?: string;
  url?: string;
  createdAt: number;
  updatedAt: number;
}

interface WorkCenterAction {
  readonly id: string;
  readonly label: string;
  canRun(item: WorkItem): boolean;
  run(item: WorkItem): Promise<void>;
}

interface WorkCenterApi {
  registerProvider(provider: unknown): Disposable;
  registerAction(action: WorkCenterAction): Disposable;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const coreExtension = vscode.extensions.getExtension<WorkCenterApi>('mthalman.workcenter');
  if (!coreExtension) {
    console.error('WorkCenter AI Reviewer: core extension not found');
    return;
  }

  let api;
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
    console.error('WorkCenter AI Reviewer: core extension API not available');
    return;
  }

  const action = new AiReviewAction();
  const actionDisposable = api.registerAction(action);
  context.subscriptions.push(actionDisposable);
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
