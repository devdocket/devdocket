import * as vscode from 'vscode';

/**
 * Prompt the user to select an AI language model.
 * Auto-selects when only one model is available.
 * Returns undefined if the user cancels or no models are available.
 */
export async function selectModel(title: string): Promise<vscode.LanguageModelChat | undefined> {
  const models = await vscode.lm.selectChatModels();
  if (models.length === 0) {
    vscode.window.showWarningMessage(`${title}: No language model available. Install GitHub Copilot.`);
    return undefined;
  }

  if (models.length === 1) {
    return models[0];
  }

  const items = models.map(model => ({
    label: model.name,
    description: `${model.vendor} · ${model.family}`,
    model,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `${title}: Select AI Model`,
    placeHolder: 'Choose a language model',
  });

  return picked?.model;
}
