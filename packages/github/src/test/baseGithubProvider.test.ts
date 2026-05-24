import { describe, expect, it, vi, afterEach } from 'vitest';
import { authentication, commands, env, window, workspace } from 'vscode';
import { type ProviderItem } from '@devdocket/shared';
import { BaseGitHubProvider, resetGitHubSsoNotificationDedupeForTests } from '../baseGithubProvider';
import { GitHubSsoError } from '../githubApiHelpers';

class TestGitHubProvider extends BaseGitHubProvider {
  readonly id = 'test-github';
  readonly label = 'Test GitHub';
  readonly fetchImpl = vi.fn(async () => {
    this.publishProviderItems([]);
  });

  publishForTest(items: ProviderItem[]): void {
    this.publishProviderItems(items);
  }

  warnForTest(message: string, isUserTriggered: boolean): void {
    this.warnOnFetchFailure(message, isUserTriggered);
  }

  protected async fetchAndPublish(accessToken: string, isUserTriggered: boolean, signal?: AbortSignal): Promise<void> {
    await this.fetchImpl(accessToken, isUserTriggered, signal);
  }
}

describe('BaseGitHubProvider repository filtering', () => {
  afterEach(() => {
    resetGitHubSsoNotificationDedupeForTests();
    vi.mocked(authentication.getSession).mockReset();
    vi.mocked(commands.executeCommand).mockReset();
    vi.mocked(env.openExternal).mockReset();
    vi.mocked(window.showErrorMessage).mockReset();
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

  it('opens the organization SSO URL from background refresh errors', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue({ accessToken: 'token' } as any);
    vi.mocked(window.showErrorMessage).mockResolvedValue('Authorize in browser' as any);
    const provider = new TestGitHubProvider();
    const error = new GitHubSsoError({
      orgName: 'example-open',
      ssoUrl: 'https://github.com/orgs/example-open/sso?authorization_request=abc123',
    });
    provider.fetchImpl
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);

    await expect(provider.refreshInBackground()).rejects.toThrow(error);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      'DevDocket: GitHub requires SSO authorization for the "example-open" organization\nbefore DevDocket can refresh items from it.',
      'Authorize in browser',
      'Retry',
      'Dismiss',
    );
    expect(env.openExternal).toHaveBeenCalledWith(expect.objectContaining({ toString: expect.any(Function) }));
    expect(provider.fetchImpl).toHaveBeenCalledTimes(2);

    provider.dispose();
  });

  it('falls back to the org SSO page when the header omits a direct authorization URL', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue({ accessToken: 'token' } as any);
    vi.mocked(window.showErrorMessage).mockResolvedValue('Authorize in browser' as any);
    const provider = new TestGitHubProvider();
    const error = new GitHubSsoError({
      orgName: 'example-fallback',
    });
    provider.fetchImpl
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);

    await expect(provider.refreshInBackground()).rejects.toThrow(error);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(env.openExternal).toHaveBeenCalledWith(expect.objectContaining({
      toString: expect.any(Function),
    }));
    expect(env.openExternal.mock.calls[0][0].toString()).toBe('https://github.com/orgs/example-fallback/sso');

    provider.dispose();
  });

  it('omits authorize when no SSO URL can be derived', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue({ accessToken: 'token' } as any);
    vi.mocked(window.showErrorMessage).mockResolvedValue('Dismiss' as any);
    const provider = new TestGitHubProvider();
    const error = new GitHubSsoError();
    provider.fetchImpl.mockRejectedValue(error);

    await expect(provider.refreshInBackground()).rejects.toThrow(error);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      'DevDocket: GitHub requires SSO authorization for this organization\nbefore DevDocket can refresh items from it.',
      'Retry',
      'Dismiss',
    );
    expect(env.openExternal).not.toHaveBeenCalled();

    provider.dispose();
  });

  it('omits authorize when the SSO URL is not safe to open', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue({ accessToken: 'token' } as any);
    vi.mocked(window.showErrorMessage).mockResolvedValue('Dismiss' as any);
    const provider = new TestGitHubProvider();
    const error = new GitHubSsoError({
      ssoUrl: 'file:///not-safe',
    });
    provider.fetchImpl.mockRejectedValue(error);

    await expect(provider.refreshInBackground()).rejects.toThrow(error);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      'DevDocket: GitHub requires SSO authorization for this organization\nbefore DevDocket can refresh items from it.',
      'Retry',
      'Dismiss',
    );
    expect(env.openExternal).not.toHaveBeenCalled();

    provider.dispose();
  });

  it('shows the refresh-oriented SSO message for user-triggered refreshes', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue({ accessToken: 'token' } as any);
    vi.mocked(window.showErrorMessage).mockResolvedValue('Dismiss' as any);
    const provider = new TestGitHubProvider();
    const error = new GitHubSsoError({
      orgName: 'example-refresh',
    });
    provider.fetchImpl.mockRejectedValue(error);

    await provider.refresh();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      'DevDocket: GitHub requires SSO authorization for the "example-refresh" organization\nbefore DevDocket can refresh items from it.',
      'Authorize in browser',
      'Retry',
      'Dismiss',
    );

    provider.dispose();
  });

  it('deduplicates non-interactive refresh SSO prompts', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue({ accessToken: 'token' } as any);
    vi.mocked(window.showErrorMessage).mockResolvedValue('Dismiss' as any);
    const provider = new TestGitHubProvider();
    const error = new GitHubSsoError({
      orgName: 'example-noninteractive',
    });
    provider.fetchImpl.mockRejectedValue(error);

    await provider.refresh(undefined, { interactive: false });
    await provider.refresh(undefined, { interactive: false });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);

    provider.dispose();
  });

  it('keeps background SSO prompts deduplicated after dismiss', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue({ accessToken: 'token' } as any);
    vi.mocked(window.showErrorMessage).mockResolvedValue('Dismiss' as any);
    const provider = new TestGitHubProvider();
    const error = new GitHubSsoError({
      orgName: 'example-dismiss',
      ssoUrl: 'https://github.com/orgs/example-dismiss/sso?authorization_request=abc123',
    });
    provider.fetchImpl.mockRejectedValue(error);

    await expect(provider.refreshInBackground()).rejects.toThrow(error);
    await expect(provider.refreshInBackground()).rejects.toThrow(error);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);

    provider.dispose();
  });
});
