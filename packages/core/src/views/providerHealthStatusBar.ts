import * as vscode from 'vscode';
import { ProviderRegistry } from '../services/providerRegistry';
import { buildProviderTooltip } from './providerTooltip';

/**
 * Status bar item that shows a warning when any provider is unhealthy.
 * Click to open quick-pick with provider health details.
 */
export class ProviderHealthStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private healthChangeSub: vscode.Disposable;
  private registerSub: vscode.Disposable;

  constructor(private providerRegistry: ProviderRegistry) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.statusBarItem.command = 'devdocket.showProviderHealthQuickPick';
    
    // Update on provider health changes
    this.healthChangeSub = providerRegistry.onDidChangeProviderHealth(() => {
      this.update();
    });
    
    // Update when new providers register
    this.registerSub = providerRegistry.onDidRegisterProvider(() => {
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

    if (unhealthyProviders.length === 0) {
      this.statusBarItem.hide();
      return;
    }

    const count = unhealthyProviders.length;
    this.statusBarItem.text = `$(warning) ${count} provider${count === 1 ? '' : 's'} unhealthy`;
    this.statusBarItem.tooltip = 'Click to view provider health details';
    this.statusBarItem.show();
  }

  dispose(): void {
    this.healthChangeSub.dispose();
    this.registerSub.dispose();
    this.statusBarItem.dispose();
  }
}

/**
 * Quick-pick command to show provider health details.
 */
export async function showProviderHealthQuickPick(providerRegistry: ProviderRegistry): Promise<void> {
  const providers = providerRegistry.getProviders();
  
  if (providers.length === 0) {
    vscode.window.showInformationMessage('No providers are registered.');
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
    
    let description = health.status;
    if (health.lastError) {
      description = `${health.status} — ${health.lastError}`;
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
      const tooltip = buildProviderTooltip(provider.label, health);
      
      // Show detailed message based on health status
      if (health.status === 'unhealthy' && health.lastError) {
        const action = await vscode.window.showWarningMessage(
          `${provider.label} is unhealthy: ${health.lastError}`,
          'Refresh',
        );
        
        if (action === 'Refresh') {
          await vscode.commands.executeCommand('devdocket.refresh');
        }
      } else {
        vscode.window.showInformationMessage(`${provider.label} is ${health.status}.`);
      }
    }
  }
}
