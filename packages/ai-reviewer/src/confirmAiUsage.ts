import * as vscode from 'vscode';

/**
 * Show a modal confirmation prompt before proceeding with an AI action.
 * Returns true if the user confirms, false if they dismiss or cancel.
 */
export async function confirmAiUsage(message: string): Promise<boolean> {
  const proceed = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    'Continue',
  );
  return proceed === 'Continue';
}
