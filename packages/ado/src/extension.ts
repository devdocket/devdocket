import * as vscode from 'vscode';
import { AdoWorkItemProvider } from './adoWorkItemProvider';
import { AdoPrReviewProvider } from './adoPrReviewProvider';
import { AdoMyPrsProvider } from './adoMyPrsProvider';
import { AdoPipelineWatcher } from './adoPipelineWatcher';
import { AdoPRWatcher } from './adoPRWatcher';
import { parseAdoProjectsConfig } from './configParser';
import { validateRefreshInterval, type DevDocketApi } from '@devdocket/shared';
import { logger, setLogger } from './logger';

const OPEN_SETTINGS = 'Open Settings';
const ADO_PROJECTS_SETTING = 'devDocketAdo.projects';

function showAdoProjectsSettingsWarning(message: string): void {
  void vscode.window.showWarningMessage(message, OPEN_SETTINGS).then(action => {
    if (action === OPEN_SETTINGS) {
      void vscode.commands.executeCommand('workbench.action.openSettings', ADO_PROJECTS_SETTING);
    }
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('DevDocket Azure DevOps', { log: true });
  context.subscriptions.push(log);
  setLogger(log);

  log.info('DevDocket Azure DevOps activating...');

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

  let orgWarningShown = false;
  let configurableDisposables: vscode.Disposable[] = [];
  const disposeConfigurableDisposables = () => {
    const disposablesToDispose = configurableDisposables;
    configurableDisposables = [];
    for (const disposable of disposablesToDispose) {
      disposable.dispose();
    }
  };

  let watcherRegistered = false;
  if (typeof api.registerRunWatcher === 'function') {
    context.subscriptions.push(api.registerRunWatcher(new AdoPipelineWatcher()));
    watcherRegistered = true;
  }

  let prWatcherRegistered = false;
  if (typeof api.registerPRWatcher === 'function') {
    context.subscriptions.push(api.registerPRWatcher(new AdoPRWatcher()));
    prWatcherRegistered = true;
  }

  const configureProviders = () => {
    disposeConfigurableDisposables();

    const config = vscode.workspace.getConfiguration('devDocketAdo');
    const projects = config.get<string[]>('projects', []);

    const orgConfigs = parseAdoProjectsConfig(projects);

    if (orgConfigs.length === 0) {
      const hasEntries = projects.some(p => p.trim().length > 0);
      if (hasEntries) {
        logger.info('All devDocketAdo.projects entries are invalid — entries must be "org" or "org/project"');
        if (!orgWarningShown) {
          showAdoProjectsSettingsWarning(
            'DevDocket Azure DevOps: All devDocketAdo.projects entries are invalid. Each entry must be "org" or "org/project".',
          );
          orgWarningShown = true;
        }
      } else {
        logger.info('No organizations configured — set devDocketAdo.projects to enable ADO providers');
        if (!orgWarningShown) {
          showAdoProjectsSettingsWarning(
            'DevDocket Azure DevOps: No Azure DevOps organizations configured. Add entries to devDocketAdo.projects (e.g. "myorg" or "myorg/myproject").',
          );
          orgWarningShown = true;
        }
      }
      return;
    }

    orgWarningShown = false;

    logger.debug(`Configuration: ${orgConfigs.map(c => c.projects.length > 0 ? c.projects.map(p => `${c.org}/${p}`).join(', ') : c.org).join('; ')}`);

    const intervalSeconds = validateRefreshInterval(
      config.get<number>('refreshIntervalSeconds', 300), logger,
    );

    const workItemProvider = new AdoWorkItemProvider(orgConfigs);
    const prProvider = new AdoPrReviewProvider(orgConfigs);
    const myPrsProvider = new AdoMyPrsProvider(orgConfigs);

    workItemProvider.startPeriodicRefresh(intervalSeconds);
    prProvider.startPeriodicRefresh(intervalSeconds);
    myPrsProvider.startPeriodicRefresh(intervalSeconds);

    const nextDisposables: vscode.Disposable[] = [
      api.registerProvider(workItemProvider),
      api.registerProvider(prProvider),
      api.registerProvider(myPrsProvider),
      workItemProvider,
      prProvider,
      myPrsProvider,
    ];
    configurableDisposables = nextDisposables;

    const parts = ['3 ADO providers'];
    if (watcherRegistered) { parts.push('1 watcher'); }
    if (prWatcherRegistered) { parts.push('1 PR watcher'); }
    logger.info(`Registered ${parts.join(' + ')}`);
  };

  context.subscriptions.push({ dispose: disposeConfigurableDisposables });

  configureProviders();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('devDocketAdo.projects') ||
        e.affectsConfiguration('devDocketAdo.refreshIntervalSeconds')
      ) {
        configureProviders();
      }
    }),
  );

  logger.info('DevDocket Azure DevOps activated');
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
