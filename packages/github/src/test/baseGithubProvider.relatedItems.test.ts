import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredItem, RelatedItemRef } from '@devdocket/shared';
import { BaseGitHubProvider } from '../baseGithubProvider';
import { mapPrCrossReferencesToRelatedItems } from '../githubGraphql';
import { initLogger } from '../logger';

const mockFetch = vi.fn();

class TestGitHubProvider extends BaseGitHubProvider {
  readonly id = 'test-github';
  readonly label = 'Test GitHub';

  fetchRelatedForTest(
    prs: Array<{ externalId: string; repoOwner: string; repoName: string; number: number }>,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<Map<string, RelatedItemRef[]>> {
    return this.fetchRelatedItemsForPRs(prs, accessToken, signal);
  }

  publishForTest(items: DiscoveredItem[]): void {
    this.publishDiscoveredItems(items);
  }

  protected async fetchAndPublish(): Promise<void> {
    this.publishDiscoveredItems([]);
  }
}

function issueNode(number: number, repo = 'owner/repo') {
  return { __typename: 'Issue', number, repository: { nameWithOwner: repo } };
}

function prNode(number: number, repo = 'owner/repo') {
  return { __typename: 'PullRequest', number, repository: { nameWithOwner: repo } };
}

function graphQlResponse(nodes: unknown[]) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      data: {
        repository: {
          pullRequest: {
            timelineItems: { nodes },
          },
        },
      },
    }),
  };
}

describe('GitHub related item mapping', () => {
  it('maps cross-referenced, connected, and pull-request subjects', () => {
    expect(mapPrCrossReferencesToRelatedItems([
      { __typename: 'CrossReferencedEvent', willCloseTarget: true, source: issueNode(2) },
      { __typename: 'CrossReferencedEvent', willCloseTarget: false, source: issueNode(3, 'other/repo') },
      { __typename: 'ConnectedEvent', subject: prNode(4, 'owner/other') },
    ])).toEqual([
      { externalId: 'owner/repo#2', relation: 'closes', itemType: 'issue' },
      { externalId: 'other/repo#3', relation: 'linked', itemType: 'issue' },
      { externalId: 'owner/other#4', relation: 'closes', itemType: 'pr' },
    ]);
  });

  it('applies disconnected events in order within the same fetch', () => {
    expect(mapPrCrossReferencesToRelatedItems([
      { __typename: 'ConnectedEvent', subject: issueNode(2) },
      { __typename: 'DisconnectedEvent', subject: issueNode(2) },
      { __typename: 'CrossReferencedEvent', willCloseTarget: false, source: issueNode(3) },
    ])).toEqual([
      { externalId: 'owner/repo#3', relation: 'linked', itemType: 'issue' },
    ]);

    expect(mapPrCrossReferencesToRelatedItems([
      { __typename: 'ConnectedEvent', subject: issueNode(2) },
      { __typename: 'DisconnectedEvent', subject: issueNode(2) },
      { __typename: 'ConnectedEvent', subject: issueNode(2) },
    ])).toEqual([
      { externalId: 'owner/repo#2', relation: 'closes', itemType: 'issue' },
    ]);
  });

  it('dedupes by externalId and itemType, preferring closes over linked', () => {
    expect(mapPrCrossReferencesToRelatedItems([
      { __typename: 'CrossReferencedEvent', willCloseTarget: false, source: issueNode(2) },
      { __typename: 'CrossReferencedEvent', willCloseTarget: true, source: issueNode(2) },
      { __typename: 'CrossReferencedEvent', willCloseTarget: false, source: prNode(2) },
    ])).toEqual([
      { externalId: 'owner/repo#2', relation: 'closes', itemType: 'issue' },
      { externalId: 'owner/repo#2', relation: 'linked', itemType: 'pr' },
    ]);
  });

  it('caps mapped timeline nodes at 100', () => {
    const nodes = Array.from({ length: 101 }, (_, index) => ({
      __typename: 'ConnectedEvent',
      subject: issueNode(index + 1),
    }));

    const refs = mapPrCrossReferencesToRelatedItems(nodes);
    expect(refs).toHaveLength(100);
    expect(refs.at(-1)?.externalId).toBe('owner/repo#100');
  });

  it('ignores malformed payload nodes defensively', () => {
    expect(mapPrCrossReferencesToRelatedItems([
      null,
      { __typename: 'CrossReferencedEvent', willCloseTarget: true, source: { __typename: 'Issue', number: '2', repository: { nameWithOwner: 'owner/repo' } } },
      { __typename: 'ConnectedEvent', subject: { __typename: 'Milestone', number: 1, repository: { nameWithOwner: 'owner/repo' } } },
    ])).toEqual([]);
  });
});

describe('BaseGitHubProvider related item fetching', () => {
  let provider: TestGitHubProvider;
  let mockChannel: { appendLine: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new TestGitHubProvider();
    mockChannel = { appendLine: vi.fn() };
    initLogger(mockChannel as any, 0);
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  it('fetches related items for each PR and preserves cross-repo refs', async () => {
    mockFetch.mockResolvedValue(graphQlResponse([
      { __typename: 'CrossReferencedEvent', willCloseTarget: true, source: issueNode(42, 'other/repo') },
    ]));

    const result = await provider.fetchRelatedForTest([
      { externalId: 'owner/repo#5', repoOwner: 'owner', repoName: 'repo', number: 5 },
    ], 'token');

    expect(mockFetch).toHaveBeenCalledWith('https://api.github.com/graphql', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }));
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).variables).toEqual({ owner: 'owner', name: 'repo', number: 5 });
    expect(result.get('owner/repo#5')).toEqual([
      { externalId: 'other/repo#42', relation: 'closes', itemType: 'issue' },
    ]);
  });

  it('collapses per-PR failures to no relatedItems and logs the failure summary', async () => {
    mockFetch.mockImplementation(async (_url: string, options: { body?: string }) => {
      const variables = JSON.parse(options.body ?? '{}').variables;
      if (variables.number === 1) {
        return graphQlResponse([{ __typename: 'ConnectedEvent', subject: issueNode(2) }]);
      }
      return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) };
    });

    const result = await provider.fetchRelatedForTest([
      { externalId: 'owner/repo#1', repoOwner: 'owner', repoName: 'repo', number: 1 },
      { externalId: 'owner/repo#2', repoOwner: 'owner', repoName: 'repo', number: 2 },
    ], 'token');

    expect(result.has('owner/repo#1')).toBe(true);
    expect(result.has('owner/repo#2')).toBe(false);
    expect(mockChannel.appendLine.mock.calls.some(call => call[0].includes('[WARN]') && call[0].includes('Failed to fetch related items for PR owner/repo#2'))).toBe(true);
    expect(mockChannel.appendLine.mock.calls.some(call => call[0].includes('[DEBUG]') && call[0].includes('Failed to fetch related items for PR owner/repo#2'))).toBe(false);
    expect(mockChannel.appendLine.mock.calls.some(call => call[0].includes('[INFO] Fetched related items for 1/2 PRs (1 failures)'))).toBe(true);
  });

  it('keeps empty successful batches out of info logs', async () => {
    mockFetch.mockResolvedValue(graphQlResponse([]));

    const result = await provider.fetchRelatedForTest([
      { externalId: 'owner/repo#1', repoOwner: 'owner', repoName: 'repo', number: 1 },
    ], 'token');

    expect(result.size).toBe(0);
    expect(mockChannel.appendLine.mock.calls.some(call => call[0].includes('[INFO] Fetched related items for 0/1 PRs (0 failures)'))).toBe(false);
    expect(mockChannel.appendLine.mock.calls.some(call => call[0].includes('[DEBUG] Fetched related items for 0/1 PRs (0 failures)'))).toBe(true);
  });

  it('propagates cancellation as AbortError', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(provider.fetchRelatedForTest([
      { externalId: 'owner/repo#1', repoOwner: 'owner', repoName: 'repo', number: 1 },
    ], 'token', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
