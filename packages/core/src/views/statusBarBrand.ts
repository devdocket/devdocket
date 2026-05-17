import * as vscode from 'vscode';

export const statusBarLogoIconSetting = 'devdocket.statusBar.useLogoIcon';

export function getStatusBarBrandPrefix(): string {
  const useLogoIcon = vscode.workspace
    .getConfiguration()
    .get<boolean>(statusBarLogoIconSetting, false);
  return useLogoIcon ? '$(devdocket-logo)' : 'DevDocket';
}

export function affectsStatusBarLogoIconSetting(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(statusBarLogoIconSetting);
}
