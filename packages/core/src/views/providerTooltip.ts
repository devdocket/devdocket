import * as vscode from 'vscode';
import { ProviderHealthStatus } from '../services/providerRegistry';
import { formatRelativeTime } from '../utils/time';

/**
 * Build a tooltip for a provider tree node showing its label and health status.
 * Shared by Inbox and Sources tree providers to keep tooltip rendering consistent.
 */
export function buildProviderTooltip(label: string, health: ProviderHealthStatus): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**`);
  md.appendText(label);
  md.appendMarkdown(`**\n\n`);
  if (health.lastRefreshTime) {
    md.appendMarkdown(`Last refreshed: `);
    md.appendText(formatRelativeTime(health.lastRefreshTime));
    md.appendMarkdown(`\n\n`);
  }
  if (health.status === 'unhealthy' && health.lastError) {
    md.appendMarkdown(`$(warning) **Refresh failed:** `);
    md.appendText(health.lastError);
    md.appendMarkdown(`\n\n`);
  }
  md.supportThemeIcons = true;
  return md;
}
