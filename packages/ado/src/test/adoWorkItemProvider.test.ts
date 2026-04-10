import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, window } from 'vscode';
import { AdoWorkItemProvider } from '../adoWorkItemProvider';

const mockFetch = vi.fn();

function createWiqlResponse(ids: number[]) {
  return {
    workItems: ids.map(id => ({ id, url: `https://dev.azure.com/myorg/_apis/wit/workitems/${id}` })),
  };
}

function createWorkItemDetail(id: number, title: string, project = 'MyProject', type = 'User Story') {
  return {
    id,
    fields: {
      'System.Title': title,
      'System.Description': `<p>Description for ${id}</p>`,
      'System.TeamProject': project,
      'System.WorkItemType': type,
      'System.State': 'Active',
    },
    _links: {
      html: { href: `https://dev.azure.com/myorg/${project}/_workitems/edit/${id}` },
    },
  };
}

describe('AdoWorkItemProvider', () => {
  let provider: AdoWorkItemProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    provider = new AdoWorkItemProvider('myorg', ['MyProject']);

    vi.mocked(authentication.getSession).mockResolvedValue({
      accessToken: 'test-token',
      id: 'session-1',
      scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      account: { id: '1', label: 'testuser' },
    } as any);
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  it('has correct id and label', () => {
    expect(provider.id).toBe('ado-work-items');
    expect(provider.label).toBe('Azure DevOps Work Items');
  });

  it('fires empty items when no auth session exists', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches assigned work items via WIQL and detail APIs', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([1, 2]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            createWorkItemDetail(1, 'Fix login bug'),
            createWorkItemDetail(2, 'Add search', 'MyProject', 'Bug'),
          ],
        }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call: WIQL query
    expect(mockFetch).toHaveBeenCalledWith(
      'https://dev.azure.com/myorg/MyProject/_apis/wit/wiql?api-version=7.1',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      externalId: 'MyProject/1',
      title: 'User Story 1: Fix login bug',
      description: 'Description for 1',
      url: 'https://dev.azure.com/myorg/MyProject/_workitems/edit/1',
      group: 'MyProject',
      reason: 'assigned',
    });
    expect(items[1]).toEqual({
      externalId: 'MyProject/2',
      title: 'Bug 2: Add search',
      description: 'Description for 2',
      url: 'https://dev.azure.com/myorg/MyProject/_workitems/edit/2',
      group: 'MyProject',
      reason: 'assigned',
    });
  });

  it('strips HTML tags from description', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([1]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{
            ...createWorkItemDetail(1, 'Test'),
            fields: {
              ...createWorkItemDetail(1, 'Test').fields,
              'System.Description': '<div><b>Bold</b> text <a href="#">link</a></div>',
            },
          }],
        }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].description).toBe('Bold text link');
  });

  it('truncates description to 200 chars', async () => {
    const longDescription = '<p>' + 'A'.repeat(300) + '</p>';
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([1]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{
            ...createWorkItemDetail(1, 'Long'),
            fields: {
              ...createWorkItemDetail(1, 'Long').fields,
              'System.Description': longDescription,
            },
          }],
        }),
      });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    const items = listener.mock.calls[0][0];
    expect(items[0].description!.length).toBe(200);
  });

  it('fires empty items when WIQL returns no work items', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => createWiqlResponse([]),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledWith([]);
    // Should not make a detail request
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('handles WIQL query failure gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Should still fire with empty items
    expect(listener).toHaveBeenCalledWith([]);
  });

  it('shows warning on failure for user-triggered refresh', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await provider.refresh();

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch work items'),
    );
  });

  it('does not show warning for background refresh failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const refreshBg = (provider as any).refreshInBackground.bind(provider);
    await refreshBg();

    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('fires empty items when cancellation is requested before auth', async () => {
    const token = { isCancellationRequested: true } as any;

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh(token);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fires empty items when cancellation is requested after auth', async () => {
    const token = { isCancellationRequested: false } as any;
    vi.mocked(authentication.getSession).mockImplementation(async () => {
      token.isCancellationRequested = true;
      return {
        accessToken: 'test-token',
        id: 'session-1',
        scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        account: { id: '1', label: 'testuser' },
      } as any;
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh(token);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fires empty items on background refresh when no session exists', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    const refreshBg = (provider as any).refreshInBackground.bind(provider);
    await refreshBg();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('handles authentication failure gracefully', async () => {
    vi.mocked(authentication.getSession).mockRejectedValue(new Error('Auth failed'));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    await expect(provider.refresh()).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
  });

  it('fires empty items when refresh catch block is hit', async () => {
    vi.spyOn(provider as any, 'fetchAndPublishWorkItems').mockRejectedValue(new Error('unexpected'));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
  });

  it('fires empty items when doBackgroundRefresh catch block is hit', async () => {
    vi.spyOn(provider as any, 'fetchAndPublishWorkItems').mockRejectedValue(new Error('unexpected'));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    const refreshBg = (provider as any).refreshInBackground.bind(provider);
    await refreshBg();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
  });

  it('startPeriodicRefresh schedules a repeating timer', () => {
    vi.useFakeTimers();

    const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
    provider.startPeriodicRefresh(60);

    expect(refreshSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('stopPeriodicRefresh clears the timer', () => {
    vi.useFakeTimers();

    const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
    provider.startPeriodicRefresh(60);
    provider.stopPeriodicRefresh();

    vi.advanceTimersByTime(120_000);
    expect(refreshSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('dispose stops periodic refresh and disposes emitter', () => {
    vi.useFakeTimers();

    const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
    provider.startPeriodicRefresh(60);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    provider.dispose();

    vi.advanceTimersByTime(120_000);
    expect(refreshSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('handles WIQL network error gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).toHaveBeenCalledWith([]);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch work items'),
    );
  });

  it('handles detail batch network error with partial results', async () => {
    // WIQL returns 201 items to trigger two batches (batch size is 200)
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse(ids),
      })
      // First batch (items 1-200) succeeds with one item for simplicity
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [createWorkItemDetail(1, 'Survived')],
        }),
      })
      // Second batch (item 201) fails with network error
      .mockRejectedValueOnce(new Error('Network error'));

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Partial results from the first batch are preserved
    const items = listener.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0].title).toContain('Survived');
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch work items'),
    );
  });

  it('uses org-level WIQL when no projects are configured', async () => {
    provider.dispose();
    provider = new AdoWorkItemProvider('myorg', []);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => createWiqlResponse([]),
    });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://dev.azure.com/myorg/_apis/wit/wiql?api-version=7.1',
      expect.any(Object),
    );
  });

  it('fires empty items when org name is invalid', async () => {
    provider.dispose();
    provider = new AdoWorkItemProvider('../evil', ['MyProject']);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
  });

  it('skips invalid projects and fetches only valid ones', async () => {
    provider.dispose();
    provider = new AdoWorkItemProvider('myorg', ['ValidProject', '../bad', 'AlsoValid']);

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => createWiqlResponse([]) })
      .mockResolvedValueOnce({ ok: true, json: async () => createWiqlResponse([]) });

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://dev.azure.com/myorg/ValidProject/_apis/wit/wiql?api-version=7.1',
      expect.any(Object),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://dev.azure.com/myorg/AlsoValid/_apis/wit/wiql?api-version=7.1',
      expect.any(Object),
    );
  });

  it('fires empty items when all configured projects are invalid', async () => {
    provider.dispose();
    provider = new AdoWorkItemProvider('myorg', ['../bad', '?evil']);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([]);
  });
});
