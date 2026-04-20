import * as vscode from 'vscode';
import { toggleViewLayout, setViewLayout } from '../views/viewLayout';
import { wrapCommand } from './commandUtils';

export function registerLayoutCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devdocket.switchInboxToTree',
      wrapCommand('Failed to switch inbox layout', () => setViewLayout('inbox', 'tree'))),
    vscode.commands.registerCommand('devdocket.switchInboxToFlat',
      wrapCommand('Failed to switch inbox layout', () => setViewLayout('inbox', 'flat'))),
    vscode.commands.registerCommand('devdocket.switchQueueToTree',
      wrapCommand('Failed to switch queue layout', () => setViewLayout('queue', 'tree'))),
    vscode.commands.registerCommand('devdocket.switchQueueToFlat',
      wrapCommand('Failed to switch queue layout', () => setViewLayout('queue', 'flat'))),
    vscode.commands.registerCommand('devdocket.switchFocusToTree',
      wrapCommand('Failed to switch focus layout', () => setViewLayout('focus', 'tree'))),
    vscode.commands.registerCommand('devdocket.switchFocusToFlat',
      wrapCommand('Failed to switch focus layout', () => setViewLayout('focus', 'flat'))),
    vscode.commands.registerCommand('devdocket.switchHistoryToTree',
      wrapCommand('Failed to switch history layout', () => setViewLayout('history', 'tree'))),
    vscode.commands.registerCommand('devdocket.switchHistoryToFlat',
      wrapCommand('Failed to switch history layout', () => setViewLayout('history', 'flat'))),
    vscode.commands.registerCommand('devdocket.switchSourcesToTree',
      wrapCommand('Failed to switch sources layout', () => setViewLayout('sources', 'tree'))),
    vscode.commands.registerCommand('devdocket.switchSourcesToFlat',
      wrapCommand('Failed to switch sources layout', () => setViewLayout('sources', 'flat'))),
    vscode.commands.registerCommand('devdocket.switchWatchesToTree',
      wrapCommand('Failed to switch watches layout', () => setViewLayout('watches', 'tree'))),
    vscode.commands.registerCommand('devdocket.switchWatchesToFlat',
      wrapCommand('Failed to switch watches layout', () => setViewLayout('watches', 'flat'))),
    // Toggle commands — cycle between flat and tree layouts via a single command
    vscode.commands.registerCommand('devdocket.toggleInboxLayout',
      wrapCommand('Failed to switch inbox layout', () => toggleViewLayout('inbox'))),
    vscode.commands.registerCommand('devdocket.toggleQueueLayout',
      wrapCommand('Failed to switch queue layout', () => toggleViewLayout('queue'))),
    vscode.commands.registerCommand('devdocket.toggleFocusLayout',
      wrapCommand('Failed to switch focus layout', () => toggleViewLayout('focus'))),
    vscode.commands.registerCommand('devdocket.toggleHistoryLayout',
      wrapCommand('Failed to switch history layout', () => toggleViewLayout('history'))),
    vscode.commands.registerCommand('devdocket.toggleSourcesLayout',
      wrapCommand('Failed to switch sources layout', () => toggleViewLayout('sources'))),
    vscode.commands.registerCommand('devdocket.toggleWatchesLayout',
      wrapCommand('Failed to switch watches layout', () => toggleViewLayout('watches'))),
  );
}
