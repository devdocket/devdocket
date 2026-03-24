import * as vscode from 'vscode';
import { GitHubIssueProvider } from './githubProvider';
import { StartWorkAction } from './startWorkAction';

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  // Acquire the WorkCenter API from the core extension
  const coreExtension = vscode.extensions.getExtension('mthalman.workcenter');
  if (!coreExtension) {
    console.error('WorkCenter GitHub: core extension not found');
    return;
  }

  const api = coreExtension.isActive
    ? coreExtension.exports
    : await coreExtension.activate();

  if (!api || typeof api.registerProvider !== 'function' || typeof api.registerAction !== 'function') {
    console.error('WorkCenter GitHub: core extension API not available');
    return;
  }

  // Register the GitHub issue provider
  const provider = new GitHubIssueProvider();
  const config = vscode.workspace.getConfiguration('workcenterGithub');
  const intervalSeconds = config.get<number>('refreshIntervalSeconds', 300);
  provider.startPeriodicRefresh(intervalSeconds);

  const providerDisposable = api.registerProvider(provider);

  // Register the Start Work action
  const startWorkAction = new StartWorkAction();
  const actionDisposable = api.registerAction(startWorkAction);

  _context.subscriptions.push(
    providerDisposable,
    actionDisposable,
    { dispose: () => provider.dispose() },
  );
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
