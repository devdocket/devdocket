import * as vscode from 'vscode';
import { GitHubIssueProvider } from './githubProvider';
import { GitHubPrReviewProvider } from './githubPrReviewProvider';
import { StartWorkAction } from './startWorkAction';
import { initLogger, setLogLevel, logger, LogLevel } from './logger';

let issueProvider: GitHubIssueProvider | undefined;
let prReviewProvider: GitHubPrReviewProvider | undefined;
let providerRegistration: vscode.Disposable | undefined;
let prReviewRegistration: vscode.Disposable | undefined;

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('WorkCenter GitHub');
  _context.subscriptions.push(outputChannel);

  const logLevelConfig = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
  const logLevelMap: Record<string, LogLevel> = {
    debug: LogLevel.Debug,
    info: LogLevel.Info,
    warn: LogLevel.Warn,
    error: LogLevel.Error,
  };
  initLogger(outputChannel, logLevelMap[logLevelConfig] ?? LogLevel.Info);

  _context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workcenter.logLevel')) {
        const newLevel = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
        setLogLevel(logLevelMap[newLevel] ?? LogLevel.Info);
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
  issueProvider = new GitHubIssueProvider();
  const config = vscode.workspace.getConfiguration('workcenterGithub');
  const intervalSeconds = config.get<number>('refreshIntervalSeconds', 300);
  issueProvider.startPeriodicRefresh(intervalSeconds);

  providerRegistration = api.registerProvider(issueProvider);

  // Register the GitHub PR review provider
  prReviewProvider = new GitHubPrReviewProvider();
  prReviewProvider.startPeriodicRefresh(intervalSeconds);
  prReviewRegistration = api.registerProvider(prReviewProvider);

  // Register the Start Work action
  const startWorkAction = new StartWorkAction();
  const actionDisposable = api.registerAction(startWorkAction);

  _context.subscriptions.push(
    { dispose: () => providerRegistration?.dispose() },
    { dispose: () => prReviewRegistration?.dispose() },
    actionDisposable,
    { dispose: () => issueProvider?.dispose() },
    { dispose: () => prReviewProvider?.dispose() },
  );

  logger.info('WorkCenter GitHub activated, registered 2 providers');
}

export function deactivate(): void {
  logger.info('WorkCenter GitHub deactivating...');
  providerRegistration?.dispose();
  prReviewRegistration?.dispose();
  issueProvider?.dispose();
  prReviewProvider?.dispose();
  providerRegistration = undefined;
  prReviewRegistration = undefined;
  issueProvider = undefined;
  prReviewProvider = undefined;
  logger.info('WorkCenter GitHub deactivated');
}
