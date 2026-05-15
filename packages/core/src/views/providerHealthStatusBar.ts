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

/**
 * Status bar item that shows provider health at a glance.
 * Click to open quick-pick with provider health details.
 */
export class ProviderHealthStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private healthChangeSub: vscode.Disposable;
  private registerSub: vscode.Disposable;
  private discoveredChangesSub: vscode.Disposable;

  constructor(private providerRegistry: ProviderRegistry) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100000);
    this.statusBarItem.command = 'devdocket.showProviderHealthQuickPick';
    
    // Update on provider health changes
    this.healthChangeSub = providerRegistry.onDidChangeProviderHealth(() => {
      this.update();
    });
    
    // Update when new providers register
    this.registerSub = providerRegistry.onDidRegisterProvider(() => {
      this.update();
    });
    
    // Update when discovered items change (fires on provider disposal)
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

    const unhealthyProviders = providers.filter(p => {
      const health = this.providerRegistry.getProviderHealth(p.id);
      return health.status === 'unhealthy';
    });

    const count = unhealthyProviders.length;
    if (count > 0) {
      this.statusBarItem.text = `$(warning) ${formatProviderCount(count)} unhealthy`;
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
      const lastRefresh = health.lastRefreshTime
        ? `last refreshed ${health.lastRefreshTime.toLocaleString()}`
        : 'not refreshed yet';
      const error = health.lastError ? ` — ${sanitizeError(health.lastError)}` : '';
      return `${provider.label}: ${health.status}${error} (${lastRefresh})`;
    });

    return ['Click to view provider health details', '', ...providerLines].join('\n');
  }

  dispose(): void {
    this.healthChangeSub.dispose();
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

  // Sort: unhealthy first, then by label
  const sortedProviders = providers.slice().sort((a, b) => {
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
    const icon = health.status === 'unhealthy' ? '$(warning)' : 
                 health.status === 'healthy' ? '$(pass)' :
                 '$(circle-outline)';
    
    let description: string = health.status;
    if (health.lastError) {
      description = `${health.status} — ${sanitizeError(health.lastError)}`;
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
      const health = providerRegistry.getProviderHealth(provider.id);
      
      // Show detailed message based on health status
      if (health.status === 'unhealthy' && health.lastError) {
        const action = await vscode.window.showWarningMessage(
          `${provider.label} is unhealthy: ${sanitizeError(health.lastError, 200)}`,
          'Refresh',
        );
        
        if (action === 'Refresh') {
          await vscode.commands.executeCommand('devdocket.refresh');
        }
      } else {
        void vscode.window.showInformationMessage(`${provider.label} is ${health.status}.`);
      }
    }
  }
}
