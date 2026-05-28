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

type ConfigurableGitHubProvider = GitHubIssueProvider | GitHubPrReviewProvider | GitHubMyPrsProvider | GitHubMentionsProvider;

function hasWorkspaceFolder(): boolean {
  return !!vscode.workspace.workspaceFolders?.length;
}

function waitForWorkspaceFolder(context: vscode.ExtensionContext): boolean {
  if (hasWorkspaceFolder()) {
    return false;
  }

  let triggered = false;
  const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (triggered || !hasWorkspaceFolder()) {
      return;
    }
    triggered = true;
    disposable.dispose();
    activate(context).catch((err) => {
      console.error('[DevDocket GitHub] deferred activation failed', err);
    });
  });
  context.subscriptions.push(disposable);
  return true;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (waitForWorkspaceFolder(context)) {
    return;
  }

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

  const issueProvider = new GitHubIssueProvider();
  const prReviewProvider = new GitHubPrReviewProvider();
  const myPrsProvider = new GitHubMyPrsProvider();
  const mentionsProvider = new GitHubMentionsProvider(context);
  const configurableProviders: ConfigurableGitHubProvider[] = [issueProvider, prReviewProvider, myPrsProvider, mentionsProvider];
  const configurableDisposables: vscode.Disposable[] = [
    api.registerProvider(issueProvider), issueProvider,
    api.registerProvider(prReviewProvider), prReviewProvider,
    api.registerProvider(myPrsProvider), myPrsProvider,
    api.registerProvider(mentionsProvider), mentionsProvider,
  ];

  const disposeConfigurableDisposables = () => {
    for (const disposable of configurableDisposables) {
      disposable.dispose();
    }
  };

  const applyRefreshInterval = async () => {
    const config = vscode.workspace.getConfiguration('devDocketGithub');
    const intervalSeconds = validateRefreshInterval(
      config.get<number>('refreshIntervalSeconds', 300), logger,
    );

    const abortResults = await Promise.allSettled(configurableProviders.map(provider => provider.abortInFlight()));
    abortResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error(`Failed to abort in-flight refresh for GitHub provider ${configurableProviders[index]?.id ?? index}`, result.reason);
      }
    });

    for (const provider of configurableProviders) {
      provider.startPeriodicRefresh(intervalSeconds);
    }
  };

  let configureProvidersPromise = Promise.resolve();
  const queueRefreshIntervalUpdate = () => {
    configureProvidersPromise = configureProvidersPromise
      .then(() => applyRefreshInterval())
      .catch(error => {
        logger.error('Failed to update GitHub provider refresh interval', error);
      });
    return configureProvidersPromise;
  };

  context.subscriptions.push({ dispose: disposeConfigurableDisposables });

  await queueRefreshIntervalUpdate();

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
        void queueRefreshIntervalUpdate();
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
