import * as vscode from 'vscode';
import { GitHubIssueProvider } from './githubProvider';
import { GitHubPrReviewProvider } from './githubPrReviewProvider';
import { GitHubActionsWatcher } from './githubActionsWatcher';
import { GitHubPRWatcher } from './githubPRWatcher';
import { GitHubMyPrsProvider } from './githubMyPrsProvider';
import { GitHubMentionsProvider } from './githubMentionsProvider';
import { validateRefreshInterval, type DevDocketApi } from '@devdocket/shared';
import { initLogger, setLogLevel, logger, resolveLogLevel } from './logger';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('DevDocket GitHub');
  context.subscriptions.push(outputChannel);

  const logLevelConfig = vscode.workspace.getConfiguration('devDocket').get<string>('logLevel', 'info');
  initLogger(outputChannel, resolveLogLevel(logLevelConfig));
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelConfig)) {
    logger.warn(`Invalid log level '${logLevelConfig}', falling back to 'info'. Valid values: debug, info, warn, error`);
  }

  context.subscriptions.push(
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

  const api = coreExtension.exports as DevDocketApi;

  if (!api || typeof api.registerProvider !== 'function') {
    logger.error('Core extension API not available');
    return;
  }

  // Register the GitHub issue provider
  const issueProvider = new GitHubIssueProvider();
  const config = vscode.workspace.getConfiguration('devDocketGithub');
  const intervalSeconds = validateRefreshInterval(
    config.get<number>('refreshIntervalSeconds', 300), logger,
  );
  issueProvider.startPeriodicRefresh(intervalSeconds);
  context.subscriptions.push(api.registerProvider(issueProvider), issueProvider);

  // Register the GitHub PR review provider
  const prReviewProvider = new GitHubPrReviewProvider();
  prReviewProvider.startPeriodicRefresh(intervalSeconds);
  context.subscriptions.push(api.registerProvider(prReviewProvider), prReviewProvider);

  // Register the My PRs provider (authored PRs with status tracking)
  const myPrsProvider = new GitHubMyPrsProvider();
  myPrsProvider.startPeriodicRefresh(intervalSeconds);
  context.subscriptions.push(api.registerProvider(myPrsProvider), myPrsProvider);

  // Register the GitHub Mentions provider (@mentioned issues and PRs)
  const mentionsProvider = new GitHubMentionsProvider(context);
  mentionsProvider.startPeriodicRefresh(intervalSeconds);
  context.subscriptions.push(api.registerProvider(mentionsProvider), mentionsProvider);

  let watcherRegistered = false;
  if (typeof api.registerRunWatcher === 'function') {
    context.subscriptions.push(api.registerRunWatcher(new GitHubActionsWatcher()));
    watcherRegistered = true;
  }

  let prWatcherRegistered = false;
  if (typeof api.registerPRWatcher === 'function') {
    context.subscriptions.push(api.registerPRWatcher(new GitHubPRWatcher()));
    prWatcherRegistered = true;
  }

  const parts = ['4 providers'];
  if (watcherRegistered) { parts.push('1 watcher'); }
  if (prWatcherRegistered) { parts.push('1 PR watcher'); }
  logger.info(`DevDocket GitHub activated, registered ${parts.join(' + ')}`);
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
