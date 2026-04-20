import * as vscode from 'vscode';

/**
 * Prompt the user to select an AI model from available language models.
 * If only one model is available, returns it without prompting.
 * Returns undefined if the user cancels or no models are available.
 */
export async function promptForModel(
  title: string,
): Promise<vscode.LanguageModelChat | undefined> {
  const models = await vscode.lm.selectChatModels();
  if (models.length === 0) {
    vscode.window.showWarningMessage(
      `${title}: No language model available. Install GitHub Copilot.`,
    );
    return undefined;
  }

  if (models.length === 1) {
    return models[0];
  }

  const items = models.map(m => ({
    label: m.name ?? m.id,
    description: `${m.vendor} — ${m.family}`,
    detail: m.name ? m.id : undefined,
    model: m,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `${title}: Select AI Model`,
    placeHolder: 'Choose which AI model to use',
  });

  return picked?.model;
}
