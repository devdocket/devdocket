import * as vscode from 'vscode';

export const statusBarLogoIconSetting = 'devdocket.statusBar.useLogoIcon';
export const statusBarLogoThemeIcon = '$(devdocket-logo)';

export function shouldUseStatusBarLogoIcon(): boolean {
  return vscode.workspace
    .getConfiguration()
    .get<boolean>(statusBarLogoIconSetting, false);
}

export function getStatusBarBrandPrefix(): string {
  return shouldUseStatusBarLogoIcon() ? statusBarLogoThemeIcon : 'DevDocket';
}

export function affectsStatusBarLogoIconSetting(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(statusBarLogoIconSetting);
}
