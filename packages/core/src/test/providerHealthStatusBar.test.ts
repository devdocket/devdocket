import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as vscode from 'vscode';
import { ProviderHealthStatusBar, showProviderHealthQuickPick } from '../views/providerHealthStatusBar';
import type { ProviderRegistry } from '../services/providerRegistry';

function createRegistry(options: { refreshing?: string[]; unhealthy?: string[] } = {}) {
  const refreshing = new Set(options.refreshing ?? []);
  const unhealthy = new Set(options.unhealthy ?? []);
  const providers = [
    { id: 'github', label: 'GitHub' },
    { id: 'ado', label: 'Azure DevOps' },
  ];
  return {
    getProviders: vi.fn(() => providers),
    getProviderHealth: vi.fn((id: string) => unhealthy.has(id)
      ? { status: 'unhealthy' as const, lastError: 'network error' }
      : id === 'ado'
        ? { status: 'healthy' as const }
        : { status: 'unknown' as const }),
    isProviderRefreshing: vi.fn((id: string) => refreshing.has(id)),
    onDidChangeProviderHealth: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeProviderRefreshState: vi.fn(() => ({ dispose: vi.fn() })),
    onDidRegisterProvider: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeProviderItems: vi.fn(() => ({ dispose: vi.fn() })),
    refreshProvider: vi.fn().mockResolvedValue('success'),
  } as unknown as ProviderRegistry & { refreshProvider: Mock };
}

describe('ProviderHealthStatusBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a spinner status bar item while providers are refreshing', () => {
    const registry = createRegistry({ refreshing: ['ado'] });

    const statusBar = new ProviderHealthStatusBar(registry);
    const item = (vscode.window.createStatusBarItem as Mock).mock.results[0].value;

    expect(item.text).toBe('$(sync~spin) 1 provider refreshing');
    expect(item.show).toHaveBeenCalled();

    statusBar.dispose();
  });

  it('preserves warning styling while refreshing with unhealthy providers', () => {
    const registry = createRegistry({ refreshing: ['ado'], unhealthy: ['github'] });

    const statusBar = new ProviderHealthStatusBar(registry);
    const item = (vscode.window.createStatusBarItem as Mock).mock.results[0].value;

    expect(item.text).toBe('$(sync~spin) 1 refreshing, 1 unhealthy');
    expect(item.backgroundColor.id).toBe('statusBarItem.warningBackground');
    expect(item.color.id).toBe('statusBarItem.warningForeground');

    statusBar.dispose();
  });

  it('marks refreshing providers in the health quick pick', async () => {
    const registry = createRegistry({ refreshing: ['ado'] });
    (vscode.window.showQuickPick as Mock).mockResolvedValueOnce(undefined);

    await showProviderHealthQuickPick(registry);

    const items = (vscode.window.showQuickPick as Mock).mock.calls[0][0];
    expect(items[0]).toMatchObject({
      label: '$(sync~spin) Azure DevOps',
      description: 'refreshing',
      providerId: 'ado',
    });
  });

  it('refreshes only the selected provider from the quick pick', async () => {
    const registry = createRegistry();
    (vscode.window.showQuickPick as Mock).mockResolvedValueOnce({ providerId: 'github' });
    (vscode.window.showInformationMessage as Mock).mockResolvedValueOnce('Refresh');

    await showProviderHealthQuickPick(registry);

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        location: vscode.ProgressLocation.Notification,
        title: 'DevDocket: Refresh GitHub',
        cancellable: true,
      }),
      expect.any(Function),
    );
    expect(registry.refreshProvider).toHaveBeenCalledWith('github', expect.any(Object));
  });
});
