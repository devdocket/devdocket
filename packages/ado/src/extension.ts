import * as vscode from 'vscode';
import { AdoWorkItemProvider } from './adoWorkItemProvider';
import { AdoPrReviewProvider } from './adoPrReviewProvider';
import { validateRefreshInterval } from '@workcenter/shared';
import { initLogger, setLogLevel, logger, resolveLogLevel } from './logger';

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('WorkCenter ADO');
  _context.subscriptions.push(outputChannel);

  const logLevelConfig = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
  initLogger(outputChannel, resolveLogLevel(logLevelConfig));
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelConfig)) {
    logger.warn(`Invalid log level '${logLevelConfig}', falling back to 'info'. Valid values: debug, info, warn, error`);
  }

  _context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workcenter.logLevel')) {
        const newLevel = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
        setLogLevel(resolveLogLevel(newLevel));
        if (!['debug', 'info', 'warn', 'error'].includes(newLevel)) {
          logger.warn(`Invalid log level '${newLevel}', falling back to 'info'. Valid values: debug, info, warn, error`);
        }
      }
    }),
  );

  logger.info('WorkCenter ADO activating...');

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
    void vscode.window.showErrorMessage(`WorkCenter ADO: Failed to activate core extension — ${message}`);
    return;
  }

  if (!api || typeof api.registerProvider !== 'function') {
    logger.error('Core extension API not available');
    return;
  }

  let workItemProvider: AdoWorkItemProvider | undefined;
  let prProvider: AdoPrReviewProvider | undefined;
  let workItemRegistration: vscode.Disposable | undefined;
  let prRegistration: vscode.Disposable | undefined;
  let orgWarningShown = false;

  const configureProviders = () => {
    // Dispose existing providers and registrations before reconfiguring
    workItemRegistration?.dispose();
    workItemRegistration = undefined;
    prRegistration?.dispose();
    prRegistration = undefined;
    workItemProvider?.dispose();
    workItemProvider = undefined;
    prProvider?.dispose();
    prProvider = undefined;

    const config = vscode.workspace.getConfiguration('workcenterAdo');
    const org = config.get<string>('organization', '');
    const projects = config.get<string[]>('projects', []);

    if (!org) {
      logger.info('No organization configured — set workcenterAdo.organization to enable ADO providers');
      if (!orgWarningShown) {
        vscode.window.showWarningMessage('WorkCenter ADO: Azure DevOps organization not configured. Set workcenterAdo.organization in settings.');
        orgWarningShown = true;
      }
      return;
    }

    orgWarningShown = false;

    logger.debug(`Configuration: org=${org}, projects=[${projects.join(', ')}]`);

    const intervalSeconds = validateRefreshInterval(
      config.get<number>('refreshIntervalSeconds', 300), logger,
    );

    workItemProvider = new AdoWorkItemProvider(org, projects);
    prProvider = new AdoPrReviewProvider(org, projects);

    workItemProvider.startPeriodicRefresh(intervalSeconds);
    prProvider.startPeriodicRefresh(intervalSeconds);

    workItemRegistration = api.registerProvider(workItemProvider);
    prRegistration = api.registerProvider(prProvider);

    logger.info('Registered 2 ADO providers');
  };

  configureProviders();

  _context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('workcenterAdo.organization') ||
        e.affectsConfiguration('workcenterAdo.projects') ||
        e.affectsConfiguration('workcenterAdo.refreshIntervalSeconds')
      ) {
        configureProviders();
      }
    }),
    {
      dispose: () => {
        workItemRegistration?.dispose();
        prRegistration?.dispose();
        workItemProvider?.dispose();
        prProvider?.dispose();
      },
    },
  );

  logger.info('WorkCenter ADO activated');
}

export function deactivate(): void {
  // Resources disposed via subscriptions
}
