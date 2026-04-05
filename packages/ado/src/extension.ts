import * as vscode from 'vscode';
import { AdoWorkItemProvider } from './adoWorkItemProvider';
import { AdoPrReviewProvider } from './adoPrReviewProvider';
import { initLogger, setLogLevel, logger, LogLevel } from './logger';

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('WorkCenter ADO');
  _context.subscriptions.push(outputChannel);

  const logLevelConfig = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
  const logLevelMap: Record<string, LogLevel> = {
    debug: LogLevel.Debug,
    info: LogLevel.Info,
    warn: LogLevel.Warn,
    error: LogLevel.Error,
  };
  initLogger(outputChannel, logLevelMap[logLevelConfig] ?? LogLevel.Info);
  if (!(logLevelConfig in logLevelMap)) {
    logger.warn(`Invalid log level '${logLevelConfig}', falling back to 'Info'`);
  }

  _context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workcenter.logLevel')) {
        const newLevel = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
        if (!(newLevel in logLevelMap)) {
          logger.warn(`Invalid log level '${newLevel}', falling back to 'Info'`);
        }
        setLogLevel(logLevelMap[newLevel] ?? LogLevel.Info);
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
    vscode.window.showErrorMessage(`WorkCenter ADO: Failed to activate core extension — ${message}`);
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
      return;
    }

    logger.debug(`Configuration: org=${org}, projects=[${projects.join(', ')}]`);

    const intervalSeconds = config.get<number>('refreshIntervalSeconds', 300);

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
