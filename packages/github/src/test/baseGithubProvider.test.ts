import { describe, expect, it, vi, afterEach } from 'vitest';
import { authentication, commands, window, workspace } from 'vscode';
import { type ProviderItem } from '@devdocket/shared';
import { BaseGitHubProvider } from '../baseGithubProvider';

class TestGitHubProvider extends BaseGitHubProvider {
  readonly id = 'test-github';
  readonly label = 'Test GitHub';

  publishForTest(items: ProviderItem[]): void {
    this.publishProviderItems(items);
  }

  warnForTest(message: string, isUserTriggered: boolean): void {
    this.warnOnFetchFailure(message, isUserTriggered);
  }

  protected async fetchAndPublish(): Promise<void> {
    this.publishProviderItems([]);
  }
}

describe('BaseGitHubProvider repository filtering', () => {
  afterEach(() => {
    vi.mocked(authentication.getSession).mockReset();
    vi.mocked(commands.executeCommand).mockReset();
    vi.mocked(window.showWarningMessage).mockReset();
    vi.mocked(workspace.getConfiguration).mockReset();
  });

  it('filters items before Sources consumers receive provider discoveries', () => {
    vi.mocked(workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === 'filteredRepos') { return 'org/excluded\nlegacy/*\n!legacy/keep'; }
        return defaultValue;
      }),
    } as any);

    const provider = new TestGitHubProvider();
    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    provider.publishForTest([
      { externalId: 'org/allowed#1', title: 'Allowed', group: 'org/allowed' },
      { externalId: 'org/excluded#2', title: 'Excluded', group: 'org/excluded' },
      { externalId: 'legacy/drop#3', title: 'Excluded via externalId fallback' },
      { externalId: 'legacy/keep#4', title: 'Re-included', group: 'legacy/keep' },
      { externalId: 'manual-without-repo', title: 'No repo identity' },
    ]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].map((item: ProviderItem) => item.title)).toEqual([
      'Allowed',
      'Re-included',
      'No repo identity',
    ]);

    provider.dispose();
  });

  it('opens GitHub extension settings from user-triggered fetch warnings', async () => {
    vi.mocked(window.showWarningMessage).mockResolvedValue('Open Settings' as any);
    const provider = new TestGitHubProvider();

    provider.warnForTest('Failed to fetch assigned issues', true);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      'DevDocket GitHub: Failed to fetch assigned issues',
      'Open Settings',
    );
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.openSettings',
      '@ext:devdocket.devdocket-github',
    );

    provider.dispose();
  });

  it('offers GitHub sign-in when authentication fails', async () => {
    vi.mocked(window.showWarningMessage).mockResolvedValue('Sign in' as any);
    vi.mocked(authentication.getSession)
      .mockRejectedValueOnce(new Error('auth unavailable'))
      .mockResolvedValueOnce({ accessToken: 'new-token' } as any);
    const provider = new TestGitHubProvider();

    await provider.refresh();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      'DevDocket GitHub: Authentication failed — auth unavailable',
      'Sign in',
    );
    expect(authentication.getSession).toHaveBeenCalledTimes(2);
    expect(authentication.getSession).toHaveBeenLastCalledWith(
      'github',
      ['repo'],
      { createIfNone: true },
    );
    expect(commands.executeCommand).not.toHaveBeenCalledWith('github.signin');

    provider.dispose();
  });
});
