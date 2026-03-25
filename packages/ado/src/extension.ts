import * as vscode from 'vscode';
import { AdoWorkItemProvider } from './adoWorkItemProvider';
import { AdoPrReviewProvider } from './adoPrReviewProvider';

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  const coreExtension = vscode.extensions.getExtension('mthalman.workcenter');
  if (!coreExtension) {
    console.error('WorkCenter ADO: core extension not found');
    return;
  }

  let api;
  try {
    api = coreExtension.isActive
      ? coreExtension.exports
      : await coreExtension.activate();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`WorkCenter ADO: Failed to activate core extension — ${message}`);
    vscode.window.showErrorMessage(`WorkCenter ADO: Failed to activate core extension — ${message}`);
    return;
  }

  if (!api || typeof api.registerProvider !== 'function') {
    console.error('WorkCenter ADO: core extension API not available');
    return;
  }

  const config = vscode.workspace.getConfiguration('workcenterAdo');
  const org = config.get<string>('organization', '');
  const projects = config.get<string[]>('projects', []);

  if (!org) {
    return;
  }

  const workItemProvider = new AdoWorkItemProvider(org, projects);
  const prProvider = new AdoPrReviewProvider(org, projects);

  const intervalSeconds = config.get<number>('refreshIntervalSeconds', 300);
  workItemProvider.startPeriodicRefresh(intervalSeconds);
  prProvider.startPeriodicRefresh(intervalSeconds);

  _context.subscriptions.push(
    api.registerProvider(workItemProvider),
    api.registerProvider(prProvider),
    { dispose: () => workItemProvider.dispose() },
    { dispose: () => prProvider.dispose() },
  );

  await Promise.all([workItemProvider.refresh(), prProvider.refresh()]);
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
