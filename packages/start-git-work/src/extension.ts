import * as vscode from 'vscode';
import { StartWorkAction } from './startWorkAction';
import { initLogger, setLogLevel, logger, resolveLogLevel } from './logger';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('WorkCenter Start Git Work');
  context.subscriptions.push(outputChannel);

  const logLevelConfig = vscode.workspace.getConfiguration('workcenter').get<string>('logLevel', 'info');
  initLogger(outputChannel, resolveLogLevel(logLevelConfig));
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelConfig)) {
    logger.warn(`Invalid log level '${logLevelConfig}', falling back to 'info'. Valid values: debug, info, warn, error`);
  }

  context.subscriptions.push(
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

  logger.info('WorkCenter Start Git Work activating...');

  const coreExtension = vscode.extensions.getExtension('mthalman.workcenter');
  if (!coreExtension) {
    logger.error('Core extension not found');
    return;
  }

  let api;
  try {
    api = coreExtension.isActive ? coreExtension.exports : await coreExtension.activate();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to activate core extension — ${message}`);
    void vscode.window.showErrorMessage(`WorkCenter Start Git Work: Failed to activate core extension — ${message}`);
    return;
  }

  if (!api || typeof api.registerAction !== 'function') {
    logger.error('Core extension API not available');
    return;
  }

  const startWorkAction = new StartWorkAction(context.globalState);
  const actionDisposable = api.registerAction(startWorkAction);
  context.subscriptions.push(actionDisposable);

  logger.info('WorkCenter Start Git Work activated');
}

export function deactivate(): void {
  logger.info('WorkCenter Start Git Work deactivated');
}
