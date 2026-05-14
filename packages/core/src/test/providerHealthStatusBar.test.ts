import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter, ThemeColor, window } from 'vscode';
import { ProviderHealthStatusBar } from '../views/providerHealthStatusBar';

function createProviderRegistry(
  providers: Array<{ id: string; label: string }>,
  healthByProvider: Record<string, { status: 'healthy' | 'unhealthy' | 'unknown'; lastRefreshTime?: Date; lastError?: string }>,
) {
  const healthEmitter = new EventEmitter<void>();
  const registerEmitter = new EventEmitter<void>();
  const itemsEmitter = new EventEmitter<void>();

  return {
    getProviders: vi.fn(() => providers),
    getProviderHealth: vi.fn((providerId: string) => healthByProvider[providerId] ?? { status: 'unknown' }),
    onDidChangeProviderHealth: healthEmitter.event,
    onDidRegisterProvider: registerEmitter.event,
    onDidChangeProviderItems: itemsEmitter.event,
    setHealth(providerId: string, health: { status: 'healthy' | 'unhealthy' | 'unknown'; lastRefreshTime?: Date; lastError?: string }) {
      healthByProvider[providerId] = health;
      healthEmitter.fire();
    },
    fireProviderItemsChanged() {
      itemsEmitter.fire();
    },
  };
}

describe('ProviderHealthStatusBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides when no providers are registered', () => {
    const providerRegistry = createProviderRegistry([], {});

    new ProviderHealthStatusBar(providerRegistry as any);

    const statusBarItem = (window.createStatusBarItem as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(statusBarItem.hide).toHaveBeenCalled();
    expect(statusBarItem.show).not.toHaveBeenCalled();
  });

  it('shows a low-key healthy summary when every provider is healthy', () => {
    const providerRegistry = createProviderRegistry(
      [
        { id: 'github', label: 'GitHub' },
        { id: 'ado', label: 'Azure DevOps' },
      ],
      {
        github: { status: 'healthy', lastRefreshTime: new Date('2024-01-02T03:04:05Z') },
        ado: { status: 'healthy' },
      },
    );

    new ProviderHealthStatusBar(providerRegistry as any);

    const statusBarItem = (window.createStatusBarItem as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(statusBarItem.text).toBe('$(check) DevDocket • 2 providers');
    expect(statusBarItem.command).toBe('devdocket.showProviderHealthQuickPick');
    expect(statusBarItem.tooltip).toContain('GitHub: healthy');
    expect(statusBarItem.tooltip).toContain('Azure DevOps: healthy (not refreshed yet)');
    expect(statusBarItem.backgroundColor).toBeUndefined();
    expect(statusBarItem.color).toBeUndefined();
    expect(statusBarItem.show).toHaveBeenCalled();
    expect(statusBarItem.hide).not.toHaveBeenCalled();
  });

  it('switches between warning and healthy text as provider health changes', () => {
    const providerRegistry = createProviderRegistry(
      [{ id: 'github', label: 'GitHub' }],
      { github: { status: 'unhealthy', lastError: 'Token expired\nRefresh failed' } },
    );

    new ProviderHealthStatusBar(providerRegistry as any);

    const statusBarItem = (vscode.window.createStatusBarItem as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(statusBarItem.text).toBe('$(warning) 1 provider unhealthy');
    expect(statusBarItem.tooltip).toContain('GitHub: unhealthy — Token expired Refresh failed');
    expect(statusBarItem.backgroundColor).toEqual(new ThemeColor('statusBarItem.warningBackground'));
    expect(statusBarItem.color).toEqual(new ThemeColor('statusBarItem.warningForeground'));

    providerRegistry.setHealth('github', { status: 'healthy', lastRefreshTime: new Date('2024-01-02T03:04:05Z') });

    expect(statusBarItem.text).toBe('$(check) DevDocket • 1 provider');
    expect(statusBarItem.backgroundColor).toBeUndefined();
    expect(statusBarItem.color).toBeUndefined();
    expect(statusBarItem.show).toHaveBeenCalledTimes(2);
  });

  it('shows a neutral summary while registered provider health is unknown', () => {
    const providerRegistry = createProviderRegistry(
      [{ id: 'github', label: 'GitHub' }],
      { github: { status: 'unknown' } },
    );

    new ProviderHealthStatusBar(providerRegistry as any);

    const statusBarItem = (window.createStatusBarItem as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(statusBarItem.text).toBe('$(circle-outline) DevDocket • 1 provider');
    expect(statusBarItem.tooltip).toContain('GitHub: unknown (not refreshed yet)');
    expect(statusBarItem.backgroundColor).toBeUndefined();
    expect(statusBarItem.color).toBeUndefined();
    expect(statusBarItem.show).toHaveBeenCalled();
  });
});
