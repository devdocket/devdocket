import { describe, expect, it, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { type DiscoveredItem } from '@devdocket/shared';
import { BaseGitHubProvider } from '../baseGithubProvider';

class TestGitHubProvider extends BaseGitHubProvider {
  readonly id = 'test-github';
  readonly label = 'Test GitHub';

  publishForTest(items: DiscoveredItem[]): void {
    this.publishDiscoveredItems(items);
  }

  protected async fetchAndPublish(): Promise<void> {
    this.publishDiscoveredItems([]);
  }
}

describe('BaseGitHubProvider repository filtering', () => {
  afterEach(() => {
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
    expect(listener.mock.calls[0][0].map((item: DiscoveredItem) => item.title)).toEqual([
      'Allowed',
      'Re-included',
      'No repo identity',
    ]);

    provider.dispose();
  });
});
