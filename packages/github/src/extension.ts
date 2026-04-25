import * as vscode from 'vscode';
import { GitHubIssueProvider } from './githubProvider';
import { GitHubPrReviewProvider } from './githubPrReviewProvider';
import { GitHubActionsWatcher } from './githubActionsWatcher';
import { GitHubPRWatcher } from './githubPRWatcher';
import { GitHubMyPrsProvider } from './githubMyPrsProvider';
import { GitHubMentionsProvider } from './githubMentionsProvider';
import { validateRefreshInterval } from '@devdocket/shared';
import { initLogger, setLogLevel, logger, resolveLogLevel } from './logger';

let issueProvider: GitHubIssueProvider | undefined;
let prReviewProvider: GitHubPrReviewProvider | undefined;
let myPrsProvider: GitHubMyPrsProvider | undefined;
let mentionsProvider: GitHubMentionsProvider | undefined;
let providerRegistration: vscode.Disposable | undefined;
let prReviewRegistration: vscode.Disposable | undefined;
let watcherRegistration: vscode.Disposable | undefined;
let prWatcherRegistration: vscode.Disposable | undefined;
let myPrsRegistration: vscode.Disposable | undefined;
let mentionsRegistration: vscode.Disposable | undefined;

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('DevDocket GitHub');
  _context.subscriptions.push(outputChannel);

  const logLevelConfig = vscode.workspace.getConfiguration('devDocket').get<string>('logLevel', 'info');
  initLogger(outputChannel, resolveLogLevel(logLevelConfig));
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelConfig)) {
    logger.warn(`Invalid log level '${logLevelConfig}', falling back to 'info'. Valid values: debug, info, warn, error`);
  }

  _context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('devDocket.logLevel')) {
        const newLevel = vscode.workspace.getConfiguration('devDocket').get<string>('logLevel', 'info');
        setLogLevel(resolveLogLevel(newLevel));
        if (!['debug', 'info', 'warn', 'error'].includes(newLevel)) {
          logger.warn(`Invalid log level '${newLevel}', falling back to 'info'. Valid values: debug, info, warn, error`);
        }
      }
    }),
  );

  logger.info('DevDocket GitHub activating...');

  // Acquire the DevDocket API from the core extension
  const coreExtension = vscode.extensions.getExtension('mthalman.devdocket');
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
    void vscode.window.showErrorMessage(`DevDocket GitHub: Failed to activate core extension — ${message}`);
    return;
  }

  if (!api || typeof api.registerProvider !== 'function') {
    logger.error('Core extension API not available');
    return;
  }

  // Register the GitHub issue provider
  issueProvider = new GitHubIssueProvider();
  const config = vscode.workspace.getConfiguration('devDocketGithub');
  const intervalSeconds = validateRefreshInterval(
    config.get<number>('refreshIntervalSeconds', 300), logger,
  );
  issueProvider.startPeriodicRefresh(intervalSeconds);

  providerRegistration = api.registerProvider(issueProvider);

  // Register the GitHub PR review provider
  prReviewProvider = new GitHubPrReviewProvider();
  prReviewProvider.startPeriodicRefresh(intervalSeconds);
  prReviewRegistration = api.registerProvider(prReviewProvider);

  // Register the My PRs provider (authored PRs with status tracking)
  myPrsProvider = new GitHubMyPrsProvider();
  myPrsProvider.startPeriodicRefresh(intervalSeconds);
  myPrsRegistration = api.registerProvider(myPrsProvider);

  // Register the GitHub Mentions provider (@mentioned issues and PRs)
  mentionsProvider = new GitHubMentionsProvider(_context);
  mentionsProvider.startPeriodicRefresh(intervalSeconds);
  mentionsRegistration = api.registerProvider(mentionsProvider);

  // Register the GitHub Actions watcher
  if (typeof api.registerRunWatcher === 'function') {
    watcherRegistration = api.registerRunWatcher(new GitHubActionsWatcher());
  }

  // Register the GitHub PR watcher
  if (typeof api.registerPRWatcher === 'function') {
    prWatcherRegistration = api.registerPRWatcher(new GitHubPRWatcher());
  }

  const parts = ['4 providers'];
  if (watcherRegistration) { parts.push('1 watcher'); }
  if (prWatcherRegistration) { parts.push('1 PR watcher'); }
  logger.info(`DevDocket GitHub activated, registered ${parts.join(' + ')}`);
}

export function deactivate(): void {
  logger.info('DevDocket GitHub deactivating...');
  providerRegistration?.dispose();
  prReviewRegistration?.dispose();
  watcherRegistration?.dispose();
  prWatcherRegistration?.dispose();
  myPrsRegistration?.dispose();
  mentionsRegistration?.dispose();
  issueProvider?.dispose();
  prReviewProvider?.dispose();
  myPrsProvider?.dispose();
  mentionsProvider?.dispose();
  logger.info('DevDocket GitHub deactivated');
}
