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

  it('does nothing when no auth session exists', async () => {
    vi.mocked(authentication.getSession).mockResolvedValue(undefined as any);

    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    expect(listener).not.toHaveBeenCalled();
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
    });
    expect(items[1]).toEqual({
      externalId: 'MyProject/2',
      title: 'Bug 2: Add search',
      description: 'Description for 2',
      url: 'https://dev.azure.com/myorg/MyProject/_workitems/edit/2',
      group: 'MyProject',
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

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);
    await provider.refresh();

    // Should still fire with empty items
    expect(listener).toHaveBeenCalledWith([]);

    consoleError.mockRestore();
  });

  it('shows warning on failure for user-triggered refresh', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await provider.refresh();

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch work items'),
    );

    consoleError.mockRestore();
  });

  it('does not show warning for background refresh failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const refreshBg = (provider as any).refreshInBackground.bind(provider);
    await refreshBg();

    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalled();

    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it('handles authentication failure gracefully', async () => {
    vi.mocked(authentication.getSession).mockRejectedValue(new Error('Auth failed'));

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listener = vi.fn();
    provider.onDidDiscoverItems(listener);

    await expect(provider.refresh()).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    consoleError.mockRestore();
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

  it('uses org-level WIQL when no projects are configured', async () => {
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
});
