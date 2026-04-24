import * as vscode from 'vscode';
import { AdoWorkItemProvider } from './adoWorkItemProvider';
import { AdoPrReviewProvider } from './adoPrReviewProvider';
import { AdoPipelineWatcher } from './adoPipelineWatcher';
import { AdoPRWatcher } from './adoPRWatcher';
import { parseAdoProjectsConfig } from './configParser';
import { validateRefreshInterval } from '@devdocket/shared';
import { initLogger, setLogLevel, logger, resolveLogLevel } from './logger';

let workItemProvider: AdoWorkItemProvider | undefined;
let prProvider: AdoPrReviewProvider | undefined;
let workItemRegistration: vscode.Disposable | undefined;
let prRegistration: vscode.Disposable | undefined;
let watcherRegistration: vscode.Disposable | undefined;
let prWatcherRegistration: vscode.Disposable | undefined;
let orgWarningShown = false;

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('DevDocket ADO');
  _context.subscriptions.push(outputChannel);

  const logLevelConfig = vscode.workspace.getConfiguration('devdocket').get<string>('logLevel', 'info');
  initLogger(outputChannel, resolveLogLevel(logLevelConfig));
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelConfig)) {
    logger.warn(`Invalid log level '${logLevelConfig}', falling back to 'info'. Valid values: debug, info, warn, error`);
  }

  _context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('devdocket.logLevel')) {
        const newLevel = vscode.workspace.getConfiguration('devdocket').get<string>('logLevel', 'info');
        setLogLevel(resolveLogLevel(newLevel));
        if (!['debug', 'info', 'warn', 'error'].includes(newLevel)) {
          logger.warn(`Invalid log level '${newLevel}', falling back to 'info'. Valid values: debug, info, warn, error`);
        }
      }
    }),
  );

  logger.info('DevDocket ADO activating...');

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
    void vscode.window.showErrorMessage(`DevDocket ADO: Failed to activate core extension — ${message}`);
    return;
  }

  if (!api || typeof api.registerProvider !== 'function') {
    logger.error('Core extension API not available');
    return;
  }

  const configureProviders= () => {
    // Dispose existing providers and registrations before reconfiguring
    workItemRegistration?.dispose();
    workItemRegistration = undefined;
    prRegistration?.dispose();
    prRegistration = undefined;
    workItemProvider?.dispose();
    workItemProvider = undefined;
    prProvider?.dispose();
    prProvider = undefined;

    const config = vscode.workspace.getConfiguration('devdocketAdo');
    const projects = config.get<string[]>('projects', []);

    const orgConfigs = parseAdoProjectsConfig(projects);

    if (orgConfigs.length === 0) {
      const hasEntries = projects.some(p => p.trim().length > 0);
      if (hasEntries) {
        logger.info('All devdocketAdo.projects entries are invalid — entries must be "org" or "org/project"');
        if (!orgWarningShown) {
          void vscode.window.showWarningMessage(
            'DevDocket ADO: All devdocketAdo.projects entries are invalid. Each entry must be "org" or "org/project".',
          );
          orgWarningShown = true;
        }
      } else {
        logger.info('No organizations configured — set devdocketAdo.projects to enable ADO providers');
        if (!orgWarningShown) {
          void vscode.window.showWarningMessage(
            'DevDocket ADO: No Azure DevOps organizations configured. Add entries to devdocketAdo.projects (e.g. "myorg" or "myorg/myproject").',
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

    workItemProvider = new AdoWorkItemProvider(orgConfigs);
    prProvider = new AdoPrReviewProvider(orgConfigs);

    workItemProvider.startPeriodicRefresh(intervalSeconds);
    prProvider.startPeriodicRefresh(intervalSeconds);

    workItemRegistration = api.registerProvider(workItemProvider);
    prRegistration = api.registerProvider(prProvider);

    // Register ADO pipeline watcher (if core supports it)
    if (typeof api.registerRunWatcher === 'function') {
      watcherRegistration?.dispose();
      watcherRegistration = api.registerRunWatcher(new AdoPipelineWatcher());
    }

    // Register ADO PR watcher (if core supports it)
    if (typeof api.registerPRWatcher === 'function') {
      prWatcherRegistration?.dispose();
      prWatcherRegistration = api.registerPRWatcher(new AdoPRWatcher());
    }

    const parts = ['2 ADO providers'];
    if (watcherRegistration) { parts.push('1 watcher'); }
    if (prWatcherRegistration) { parts.push('1 PR watcher'); }
    logger.info(`Registered ${parts.join(' + ')}`);
  };

  configureProviders();

  _context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('devdocketAdo.projects') ||
        e.affectsConfiguration('devdocketAdo.refreshIntervalSeconds')
      ) {
        configureProviders();
      }
    }),
  );

  logger.info('DevDocket ADO activated');
}

export function deactivate(): void {
  logger.info('DevDocket ADO deactivating...');
  workItemRegistration?.dispose();
  prRegistration?.dispose();
  watcherRegistration?.dispose();
  prWatcherRegistration?.dispose();
  workItemProvider?.dispose();
  prProvider?.dispose();
  logger.info('DevDocket ADO deactivated');
}
