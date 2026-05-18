import * as vscode from 'vscode';
import { GitHubIssueProvider } from './githubProvider';
import { GitHubPrReviewProvider } from './githubPrReviewProvider';
import { GitHubActionsWatcher } from './githubActionsWatcher';
import { GitHubAdvancedSecurityWatcher } from './githubAdvancedSecurityWatcher';
import { GitHubPRWatcher } from './githubPRWatcher';
import { GitHubMyPrsProvider } from './githubMyPrsProvider';
import { GitHubMentionsProvider } from './githubMentionsProvider';
import { validateRefreshInterval, type DevDocketApi } from '@devdocket/shared';
import { logger, setLogger } from './logger';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('DevDocket GitHub', { log: true });
  context.subscriptions.push(log);
  setLogger(log);

  log.info('DevDocket GitHub activating...');

  // Acquire the DevDocket API from the core extension
  const coreExtension = vscode.extensions.getExtension('devdocket.devdocket');
  if (!coreExtension) {
    logger.error('Core extension devdocket.devdocket not found. Install or enable DevDocket.');
    return;
  }

  const api = coreExtension.exports as DevDocketApi;

  if (!api || typeof api.registerProvider !== 'function') {
    logger.error('Core extension API not available');
    return;
  }

  // Register the GitHub issue provider
  const issueProvider = new GitHubIssueProvider();

  // Register the GitHub PR review provider
  const prReviewProvider = new GitHubPrReviewProvider();

  // Register the My PRs provider (authored PRs with status tracking)
  const myPrsProvider = new GitHubMyPrsProvider();

  // Register the GitHub Mentions provider (@mentioned issues and PRs)
  const mentionsProvider = new GitHubMentionsProvider(context);

  const providers = [issueProvider, prReviewProvider, myPrsProvider, mentionsProvider];
  const configureProviders = () => {
    const config = vscode.workspace.getConfiguration('devDocketGithub');
    const intervalSeconds = validateRefreshInterval(
      config.get<number>('refreshIntervalSeconds', 300), logger,
    );
    for (const provider of providers) {
      provider.startPeriodicRefresh(intervalSeconds);
    }
  };

  configureProviders();

  context.subscriptions.push(
    api.registerProvider(issueProvider), issueProvider,
    api.registerProvider(prReviewProvider), prReviewProvider,
    api.registerProvider(myPrsProvider), myPrsProvider,
    api.registerProvider(mentionsProvider), mentionsProvider,
  );

  let watcherCount = 0;
  if (typeof api.registerRunWatcher === 'function') {
    context.subscriptions.push(
      api.registerRunWatcher(new GitHubActionsWatcher()),
      api.registerRunWatcher(new GitHubAdvancedSecurityWatcher()),
    );
    watcherCount = 2;
  }

  let prWatcherRegistered = false;
  if (typeof api.registerPRWatcher === 'function') {
    context.subscriptions.push(api.registerPRWatcher(new GitHubPRWatcher()));
    prWatcherRegistered = true;
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('devDocketGithub.refreshIntervalSeconds')) {
        configureProviders();
      }
    }),
  );

  const parts = ['4 providers'];
  if (watcherCount > 0) { parts.push(`${watcherCount} watcher${watcherCount === 1 ? '' : 's'}`); }
  if (prWatcherRegistered) { parts.push('1 PR watcher'); }
  logger.info(`DevDocket GitHub activated, registered ${parts.join(' + ')}`);
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
