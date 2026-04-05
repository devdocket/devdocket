import * as vscode from 'vscode';
import { GitHubIssueProvider } from './githubProvider';
import { GitHubPrReviewProvider } from './githubPrReviewProvider';
import { StartWorkAction } from './startWorkAction';
import { initLogger, setLogLevel, logger, resolveLogLevel } from './logger';

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('WorkCenter GitHub');
  _context.subscriptions.push(outputChannel);

  const logLevelConfig = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
  initLogger(outputChannel, resolveLogLevel(logLevelConfig));

  _context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workcenter.logLevel')) {
        const newLevel = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
        setLogLevel(resolveLogLevel(newLevel));
      }
    }),
  );

  logger.info('WorkCenter GitHub activating...');

  // Acquire the WorkCenter API from the core extension
  const coreExtension = vscode.extensions.getExtension('mthalman.workcenter');
  if (!coreExtension) {
    logger.error('Core extension not found');
    return;
  }

  let api;
  try {
    api = coreExtension.isActive
      ? coreExtension.exports
      : await coreExtension.activate();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to activate core extension — ${message}`);
    vscode.window.showErrorMessage(`WorkCenter GitHub: Failed to activate core extension — ${message}`);
    return;
  }

  if (!api || typeof api.registerProvider !== 'function' || typeof api.registerAction !== 'function') {
    logger.error('Core extension API not available');
    return;
  }

  // Register the GitHub issue provider
  const provider = new GitHubIssueProvider();
  const config = vscode.workspace.getConfiguration('workcenterGithub');
  const intervalSeconds = config.get<number>('refreshIntervalSeconds', 300);
  provider.startPeriodicRefresh(intervalSeconds);

  const providerDisposable = api.registerProvider(provider);

  // Register the GitHub PR review provider
  const prReviewProvider = new GitHubPrReviewProvider();
  prReviewProvider.startPeriodicRefresh(intervalSeconds);
  const prReviewDisposable = api.registerProvider(prReviewProvider);

  // Register the Start Work action
  const startWorkAction = new StartWorkAction();
  const actionDisposable = api.registerAction(startWorkAction);

  _context.subscriptions.push(
    providerDisposable,
    prReviewDisposable,
    actionDisposable,
    { dispose: () => provider.dispose() },
    { dispose: () => prReviewProvider.dispose() },
  );

  logger.info('WorkCenter GitHub activated, registered 2 providers');
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
