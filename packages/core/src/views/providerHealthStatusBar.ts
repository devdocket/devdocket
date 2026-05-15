import * as vscode from 'vscode';
import { ProviderRegistry } from '../services/providerRegistry';

/**
 * Sanitizes error messages for display by removing newlines and truncating.
 */
function sanitizeError(error: string, maxLength = 100): string {
  // Replace all newlines/carriage returns with spaces
  const singleLine = error.replace(/[\r\n]+/g, ' ');
  // Trim and truncate if needed
  const trimmed = singleLine.trim();
  return trimmed.length > maxLength ? trimmed.substring(0, maxLength) + '…' : trimmed;
}

function formatProviderCount(count: number): string {
  return `${count} provider${count === 1 ? '' : 's'}`;
}

async function refreshProviderWithProgress(
  providerRegistry: ProviderRegistry,
  provider: { id: string; label: string },
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `DevDocket: Refresh ${provider.label}`,
      cancellable: true,
    },
    (_progress, token) => providerRegistry.refreshProvider(provider.id, token),
  );
}

/**
 * Status bar item that shows provider health at a glance, including
 * per-provider in-flight refresh state. Click to open quick-pick with
 * provider health details.
 */
export class ProviderHealthStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private healthChangeSub: vscode.Disposable;
  private refreshStateSub: vscode.Disposable;
  private registerSub: vscode.Disposable;
  private discoveredChangesSub: vscode.Disposable;

  constructor(private providerRegistry: ProviderRegistry) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100000);
    this.statusBarItem.command = 'devdocket.showProviderHealthQuickPick';

    this.healthChangeSub = providerRegistry.onDidChangeProviderHealth(() => {
      this.update();
    });

    this.refreshStateSub = providerRegistry.onDidChangeProviderRefreshState(() => {
      this.update();
    });

    this.registerSub = providerRegistry.onDidRegisterProvider(() => {
      this.update();
    });

    this.discoveredChangesSub = providerRegistry.onDidChangeProviderItems(() => {
      this.update();
    });

    this.update();
  }

  private update(): void {
    const providers = this.providerRegistry.getProviders();

    if (providers.length === 0) {
      this.statusBarItem.hide();
      return;
    }

    const refreshingProviders = providers.filter(p => this.providerRegistry.isProviderRefreshing(p.id));
    const unhealthyProviders = providers.filter(p => {
      const health = this.providerRegistry.getProviderHealth(p.id);
      return health.status === 'unhealthy';
    });

    if (refreshingProviders.length > 0) {
      const refreshingCount = refreshingProviders.length;
      const unhealthyCount = unhealthyProviders.length;
      this.statusBarItem.text = unhealthyCount > 0
        ? `$(sync~spin) ${refreshingCount} refreshing, ${unhealthyCount} unhealthy`
        : `$(sync~spin) ${formatProviderCount(refreshingCount)} refreshing`;
      this.statusBarItem.tooltip = this.buildTooltip(providers);
      this.statusBarItem.backgroundColor = unhealthyCount > 0
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
      this.statusBarItem.color = unhealthyCount > 0
        ? new vscode.ThemeColor('statusBarItem.warningForeground')
        : undefined;
      this.statusBarItem.show();
      return;
    }

    if (unhealthyProviders.length > 0) {
      this.statusBarItem.text = `$(warning) ${formatProviderCount(unhealthyProviders.length)} unhealthy`;
      this.statusBarItem.tooltip = this.buildTooltip(providers);
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      this.statusBarItem.show();
      return;
    }

    const hasUnknownProviders = providers.some(p => this.providerRegistry.getProviderHealth(p.id).status === 'unknown');
    this.statusBarItem.text = `${hasUnknownProviders ? '$(circle-outline)' : '$(check)'} DevDocket • ${formatProviderCount(providers.length)}`;
    this.statusBarItem.tooltip = this.buildTooltip(providers);
    this.statusBarItem.backgroundColor = undefined;
    this.statusBarItem.color = undefined;
    this.statusBarItem.show();
  }

  private buildTooltip(providers: ReturnType<ProviderRegistry['getProviders']>): string {
    const providerLines = providers.map(provider => {
      const health = this.providerRegistry.getProviderHealth(provider.id);
      const isRefreshing = this.providerRegistry.isProviderRefreshing(provider.id);
      const status = isRefreshing ? 'refreshing' : health.status;
      const lastRefresh = health.lastRefreshTime
        ? `last refreshed ${health.lastRefreshTime.toLocaleString()}`
        : 'not refreshed yet';
      const error = health.lastError ? ` — ${sanitizeError(health.lastError)}` : '';
      return `${provider.label}: ${status}${error} (${lastRefresh})`;
    });

    return ['Click to view provider health details', '', ...providerLines].join('\n');
  }

  dispose(): void {
    this.healthChangeSub.dispose();
    this.refreshStateSub.dispose();
    this.registerSub.dispose();
    this.discoveredChangesSub.dispose();
    this.statusBarItem.dispose();
  }
}

/**
 * Quick-pick command to show provider health details.
 */
export async function showProviderHealthQuickPick(providerRegistry: ProviderRegistry): Promise<void> {
  const providers = providerRegistry.getProviders();

  if (providers.length === 0) {
    void vscode.window.showInformationMessage('No providers are registered.');
    return;
  }

  // Sort: in-flight first, then unhealthy, then by label
  const sortedProviders = providers.slice().sort((a, b) => {
    const aRefreshing = providerRegistry.isProviderRefreshing(a.id);
    const bRefreshing = providerRegistry.isProviderRefreshing(b.id);
    if (aRefreshing !== bRefreshing) {
      return aRefreshing ? -1 : 1;
    }

    const aHealth = providerRegistry.getProviderHealth(a.id);
    const bHealth = providerRegistry.getProviderHealth(b.id);

    if (aHealth.status === 'unhealthy' && bHealth.status !== 'unhealthy') {
      return -1;
    }
    if (aHealth.status !== 'unhealthy' && bHealth.status === 'unhealthy') {
      return 1;
    }

    return a.label.localeCompare(b.label);
  });

  interface ProviderQuickPickItem extends vscode.QuickPickItem {
    providerId: string;
  }

  const items: ProviderQuickPickItem[] = sortedProviders.map(provider => {
    const health = providerRegistry.getProviderHealth(provider.id);
    const isRefreshing = providerRegistry.isProviderRefreshing(provider.id);
    const icon = isRefreshing ? '$(sync~spin)' :
                 health.status === 'unhealthy' ? '$(warning)' :
                 health.status === 'healthy' ? '$(pass)' :
                 '$(circle-outline)';

    let description: string = isRefreshing ? 'refreshing' : health.status;
    if (health.lastError) {
      description = `${description} — ${sanitizeError(health.lastError)}`;
    }

    return {
      label: `${icon} ${provider.label}`,
      description,
      detail: health.lastRefreshTime ? `Last refreshed: ${health.lastRefreshTime.toLocaleString()}` : undefined,
      providerId: provider.id,
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Provider health status',
  });

  if (selected) {
    const provider = providers.find(p => p.id === selected.providerId);
    if (provider) {
      if (providerRegistry.isProviderRefreshing(provider.id)) {
        void vscode.window.showInformationMessage(`${provider.label} is currently refreshing.`);
        return;
      }

      const health = providerRegistry.getProviderHealth(provider.id);
      const message = health.status === 'unhealthy' && health.lastError
        ? `${provider.label} is unhealthy: ${sanitizeError(health.lastError, 200)}`
        : `${provider.label} is ${health.status}.`;
      const action = health.status === 'unhealthy'
        ? await vscode.window.showWarningMessage(message, 'Refresh')
        : await vscode.window.showInformationMessage(message, 'Refresh');

      if (action === 'Refresh') {
        await refreshProviderWithProgress(providerRegistry, provider);
      }
    }
  }
}
