import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, window } from 'vscode';
import { AdoMyPrsProvider } from '../adoMyPrsProvider';
import { setLogger } from '../logger';

const mockFetch = vi.fn();

function createMockPr(
  id: number,
  title: string,
  project = 'MyProject',
  repo = 'myrepo',
  extra: Record<string, unknown> = {},
) {
  return {
    pullRequestId: id,
    title,
    description: `Description for PR ${id}`,
    status: 'active',
    repository: {
      name: repo,
      project: { name: project },
      webUrl: `https://dev.azure.com/myorg/${project}/_git/${repo}`,
    },
    ...extra,
  };
}

function mockConnectionData(userId = 'user-uuid-123') {
  return {
    ok: true,
    json: async () => ({ authenticatedUser: { id: userId } }),
  };
}

function mockAuthSession(token = 'test-token', accountId = '1') {
  vi.mocked(authentication.getSession).mockResolvedValue({
    accessToken: token,
    id: 'session-1',
    scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
    account: { id: accountId, label: 'testuser' },
  } as any);
}

function createMockCancellationToken() {
  let isCancellationRequested = false;
  const listeners: (() => void)[] = [];

  const token = {
    get isCancellationRequested() { return isCancellationRequested; },
    onCancellationRequested: (listener: () => void) => {
      listeners.push(listener);
      return { dispose: vi.fn() };
    },
  };

  const cancel = () => {
    isCancellationRequested = true;
    listeners.forEach(listener => listener());
  };

  return { token: token as any, cancel };
}

describe('AdoMyPrsProvider', () => {
  let provider: AdoMyPrsProvider;
  let mockChannel: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    provider = new AdoMyPrsProvider([{ org: 'myorg', projects: ['MyProject'] }]);
    mockAuthSession();

    mockChannel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() };
    setLogger(mockChannel);
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  it('has correct id and label', () => {
    expect(provider.id).toBe('ado-my-prs');
    expect(provider.label).toBe('My Azure DevOps PRs');
  });

  it('fires empty items when no auth session exists', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledWith([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fires empty items when cancellation is requested before auth', async () => {
    const token = { isCancellationRequested: true } as any;

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh(token);

    expect(listener).toHaveBeenCalledWith([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses creatorId query param when fetching authored PRs', async () => {
    mockFetch
      .mockResolvedValueOnce(mockConnectionData('author-123'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [createMockPr(101, 'Fix bug')] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ reviewers: [{ vote: 0 }] }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const listUrl = mockFetch.mock.calls[1][0] as string;
    expect(listUrl).toContain('searchCriteria.creatorId=author-123');
    expect(listUrl).not.toContain('searchCriteria.reviewerId');

    const items = listener.mock.calls[0][0];
    expect(items[0]).toEqual({
      externalId: 'myorg/MyProject/myrepo/101',
      title: 'PR 101: Fix bug',
      description: 'Description for PR 101',
      url: 'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/101',
      group: 'MyProject/myrepo',
      reason: 'You authored this PR',
      state: 'Waiting on reviews',
      itemType: 'pr',
      capabilities: { gitWork: expect.any(Function) },
      badges: [{ label: 'Waiting on reviews', variant: 'info', show: 'editor' }],
    });
    expect(items[0]).not.toHaveProperty('resurfaceVersion');
  });

  it('marks draft PRs without enrichment and never resurfaces them', async () => {
    mockFetch
      .mockResolvedValueOnce(mockConnectionData())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [createMockPr(42, 'Draft PR', 'MyProject', 'myrepo', {
            isDraft: true,
            lastMergeSourceCommit: { commitId: 'abc123' },
          })],
        }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const items = listener.mock.calls[0][0];
    expect(items[0].state).toBe('Draft');
    expect(items[0]).not.toHaveProperty('resurfaceVersion');
  });

  it('keeps partial results when one project times out without cancellation', async () => {
    provider.dispose();
    provider = new AdoMyPrsProvider([{ org: 'myorg', projects: ['ProjectA', 'ProjectB'] }]);

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/connectiondata')) {
        return mockConnectionData('author-123');
      }
      if (url.includes('/ProjectA/_apis/git/pullrequests')) {
        return {
          ok: true,
          json: async () => ({ value: [createMockPr(101, 'Project A PR', 'ProjectA', 'repo1')] }),
        };
      }
      if (url.includes('/ProjectB/_apis/git/pullrequests')) {
        const error = new Error('The operation timed out.');
        error.name = 'TimeoutError';
        throw error;
      }
      if (url.includes('/repositories/repo1/pullrequests/101?')) {
        return { ok: true, json: async () => ({ reviewers: [{ vote: 0 }] }) };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    await expect(provider.refresh()).resolves.toBeUndefined();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        externalId: 'myorg/ProjectA/repo1/101',
        state: 'Waiting on reviews',
      }),
    ]);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      'DevDocket ADO: My PRs errors: failed to fetch from myorg/ProjectB',
    );
    expect(
      mockChannel.error.mock.calls.some(
        (call: unknown[]) => String(call[0]).includes('Failed to fetch My PRs from myorg/ProjectB'),
      ),
    ).toBe(false);
  });

  it('maps vote statuses from PR detail data', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/connectiondata')) {
        return mockConnectionData('author-123');
      }
      if (url.includes('searchCriteria.creatorId=author-123')) {
        return {
          ok: true,
          json: async () => ({
            value: [
              createMockPr(1, 'Draft PR', 'MyProject', 'repo1', { isDraft: true }),
              createMockPr(2, 'Rejected PR', 'MyProject', 'repo2'),
              createMockPr(3, 'Needs Author', 'MyProject', 'repo3'),
              createMockPr(4, 'Approved PR', 'MyProject', 'repo4'),
              createMockPr(5, 'In Progress PR', 'MyProject', 'repo5'),
              createMockPr(6, 'Waiting PR', 'MyProject', 'repo6'),
            ],
          }),
        };
      }
      if (url.includes('/repositories/repo2/pullrequests/2?')) {
        return { ok: true, json: async () => ({ reviewers: [{ vote: -10 }, { vote: 10 }] }) };
      }
      if (url.includes('/repositories/repo3/pullrequests/3?')) {
        return { ok: true, json: async () => ({ reviewers: [{ vote: -5 }, { vote: 0 }] }) };
      }
      if (url.includes('/repositories/repo4/pullrequests/4?')) {
        return { ok: true, json: async () => ({ reviewers: [{ vote: 10 }, { vote: 5 }] }) };
      }
      if (url.includes('/repositories/repo5/pullrequests/5?')) {
        return { ok: true, json: async () => ({ reviewers: [{ vote: 10 }, { vote: 0 }] }) };
      }
      if (url.includes('/repositories/repo6/pullrequests/6?')) {
        return { ok: true, json: async () => ({ reviewers: [{ vote: 0 }, { vote: 0 }] }) };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items.map((item: any) => item.state)).toEqual([
      'Draft',
      'Rejected',
      'Waiting for author',
      'Approved',
      'Approved',
      'Waiting on reviews',
    ]);
  });

  it('preserves the list status when PR detail enrichment returns a non-ok response', async () => {
    mockFetch
      .mockResolvedValueOnce(mockConnectionData())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [createMockPr(8, 'Fallback PR', 'MyProject', 'myrepo', { status: 'queued' })] }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].state).toBe('queued');
    expect(
      mockChannel.debug.mock.calls.some(
        (call: unknown[]) => String(call[0]).includes('Failed to fetch PR detail'),
      ),
    ).toBe(true);
  });

  it('preserves the list status when PR detail enrichment throws', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/connectiondata')) {
        return mockConnectionData();
      }
      if (url.includes('searchCriteria.creatorId=')) {
        return {
          ok: true,
          json: async () => ({ value: [createMockPr(10, 'Exploding PR', 'MyProject', 'myrepo', { status: 'queued' })] }),
        };
      }
      if (url.includes('/repositories/myrepo/pullrequests/10?')) {
        throw new Error('boom');
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].state).toBe('queued');
    expect(
      mockChannel.debug.mock.calls.some(
        (call: unknown[]) => String(call[0]).includes('Failed to enrich PR'),
      ),
    ).toBe(true);
  });

  it('handles connection data failure gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledWith([]);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('user identity'),
    );
  });

  it('does not publish items when cancellation occurs during detail enrichment', async () => {
    const { token, cancel } = createMockCancellationToken();

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/connectiondata')) {
        return mockConnectionData();
      }
      if (url.includes('searchCriteria.creatorId=')) {
        return {
          ok: true,
          json: async () => ({ value: [createMockPr(9, 'Cancelable PR')] }),
        };
      }
      if (url.includes('/repositories/myrepo/pullrequests/9?')) {
        cancel();
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh(token);

    expect(listener).not.toHaveBeenCalled();
  });
});
