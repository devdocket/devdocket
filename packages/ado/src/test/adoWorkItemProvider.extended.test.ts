import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { authentication, window } from 'vscode';
import { AdoWorkItemProvider } from '../adoWorkItemProvider';

const mockFetch = vi.fn();

function createWiqlResponse(ids: number[]) {
  return {
    workItems: ids.map(id => ({ id, url: `https://dev.azure.com/myorg/_apis/wit/workitems/${id}` })),
  };
}

function createWorkItemDetail(id: number, title: string, project = 'MyProject', type = 'User Story', state = 'Active') {
  return {
    id,
    fields: {
      'System.Title': title,
      'System.Description': `<p>Description for ${id}</p>`,
      'System.TeamProject': project,
      'System.WorkItemType': type,
      'System.State': state,
    },
    _links: {
      html: { href: `https://dev.azure.com/myorg/${project}/_workitems/edit/${id}` },
    },
  };
}

function createStatesResponse(states: { name: string; category: string }[]) {
  return {
    count: states.length,
    value: states,
  };
}

function mockAuthSession(token = 'test-token') {
  vi.mocked(authentication.getSession).mockResolvedValue({
    accessToken: token,
    id: 'session-1',
    scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
    account: { id: '1', label: 'testuser' },
  } as any);
}

describe('AdoWorkItemProvider — extended', () => {
  let provider: AdoWorkItemProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    provider = new AdoWorkItemProvider([{ org: 'myorg', projects: ['MyProject'] }]);
    mockAuthSession();

    // Default fallback: states API calls return no terminal states (items pass through)
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/workitemtypes/') && url.includes('/states')) {
        return { ok: true, json: async () => ({ count: 0, value: [] }) };
      }
      throw new Error(`Unexpected fetch call in test: ${String(url)}`);
    });
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
  });

  describe('WIQL query construction', () => {
    it('sends correct WIQL query body filtering by assignment and state', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([]),
      });

      await provider.refresh();

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.query).toContain('[System.AssignedTo] = @Me');
      expect(body.query).toContain("[System.State] <> 'Closed'");
      expect(body.query).toContain("[System.State] <> 'Removed'");
      // Verify Resolved and Done are NOT in WIQL (handled by state category filtering)
      expect(body.query).not.toContain("[System.State] <> 'Resolved'");
      expect(body.query).not.toContain("[System.State] <> 'Done'");
    });

    it('URL-encodes org and project names with special characters', async () => {
      provider.dispose();
      provider = new AdoWorkItemProvider([{ org: 'my org', projects: ['My Project'] }]);
      mockAuthSession();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([]),
      });

      await provider.refresh();

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('my%20org');
      expect(url).toContain('My%20Project');
      expect(url).not.toContain('my org');
    });
  });

  describe('state category filtering', () => {
    it('filters out work items in terminal state categories', async () => {
      // WIQL returns 3 items
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([1, 2, 3]),
      });

      // Detail fetch returns items with Active, Resolved, New states
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            createWorkItemDetail(1, 'Active Item', 'MyProject', 'User Story', 'Active'),
            createWorkItemDetail(2, 'Resolved Item', 'MyProject', 'User Story', 'Resolved'),
            createWorkItemDetail(3, 'New Item', 'MyProject', 'User Story', 'New'),
          ],
        }),
      });

      // States API for User Story returns Active=InProgress, Resolved=Resolved, New=Proposed
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createStatesResponse([
          { name: 'New', category: 'Proposed' },
          { name: 'Active', category: 'InProgress' },
          { name: 'Resolved', category: 'Resolved' },
          { name: 'Closed', category: 'Completed' },
        ]),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Only Active and New items should be published (Resolved is terminal)
      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(2);
      expect(items.map((i: any) => i.externalId)).toContain('myorg/MyProject/1'); // Active
      expect(items.map((i: any) => i.externalId)).toContain('myorg/MyProject/3'); // New
      expect(items.map((i: any) => i.externalId)).not.toContain('myorg/MyProject/2'); // Resolved
    });

    it('handles multiple work item types with different state definitions', async () => {
      // WIQL returns items of type Bug and User Story
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([1, 2, 3, 4]),
      });

      // Detail fetch returns Bug and User Story items
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            createWorkItemDetail(1, 'Bug Active', 'MyProject', 'Bug', 'Active'),
            createWorkItemDetail(2, 'Bug Resolved', 'MyProject', 'Bug', 'Resolved'),
            createWorkItemDetail(3, 'Story Active', 'MyProject', 'User Story', 'Active'),
            createWorkItemDetail(4, 'Story Done', 'MyProject', 'User Story', 'Done'),
          ],
        }),
      });

      // States API for Bug
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createStatesResponse([
          { name: 'Active', category: 'InProgress' },
          { name: 'Resolved', category: 'Resolved' }, // Terminal
          { name: 'Closed', category: 'Completed' },
        ]),
      });

      // States API for User Story
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createStatesResponse([
          { name: 'New', category: 'Proposed' },
          { name: 'Active', category: 'InProgress' },
          { name: 'Done', category: 'Completed' }, // Terminal
        ]),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Only Active items should be published (Bug Resolved and Story Done are terminal)
      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(2);
      expect(items.map((i: any) => i.title)).toContain('Bug 1: Bug Active');
      expect(items.map((i: any) => i.title)).toContain('User Story 3: Story Active');
      expect(items.map((i: any) => i.title)).not.toContain('Bug 2: Bug Resolved');
      expect(items.map((i: any) => i.title)).not.toContain('User Story 4: Story Done');
    });

    it('caches state definitions across calls', async () => {
      // First refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([1]),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [createWorkItemDetail(1, 'Item 1', 'MyProject', 'User Story', 'Active')],
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createStatesResponse([
          { name: 'Active', category: 'InProgress' },
          { name: 'Resolved', category: 'Resolved' },
        ]),
      });

      await provider.refresh();

      // Second refresh with same project and type
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([2]),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [createWorkItemDetail(2, 'Item 2', 'MyProject', 'User Story', 'Active')],
        }),
      });

      await provider.refresh();

      // States API should be called only once (first refresh: WIQL + details + states = 3, second: WIQL + details = 2)
      expect(mockFetch).toHaveBeenCalledTimes(5); // 3 + 2
      const statesApiCalls = mockFetch.mock.calls.filter((call: any) => 
        call[0].includes('workitemtypes') && call[0].includes('/states')
      );
      expect(statesApiCalls).toHaveLength(1);
    });

    it('fails open when states API returns error', async () => {
      // WIQL returns items of two types
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([1, 2]),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            createWorkItemDetail(1, 'Bug Item', 'MyProject', 'Bug', 'Resolved'),
            createWorkItemDetail(2, 'Story Item', 'MyProject', 'User Story', 'Resolved'),
          ],
        }),
      });

      // States API for Bug returns 500
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      // States API for User Story succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createStatesResponse([
          { name: 'Active', category: 'InProgress' },
          { name: 'Resolved', category: 'Resolved' }, // Terminal
        ]),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      // Bug item should NOT be filtered (fail open), Story item should be filtered
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Bug 1: Bug Item');
    });

    it('fails open when states API has network error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([1]),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [createWorkItemDetail(1, 'Item 1', 'MyProject', 'User Story', 'Resolved')],
        }),
      });

      // States API throws network error
      mockFetch.mockRejectedValueOnce(new TypeError('Network error'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Item should be kept (not filtered out)
      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('User Story 1: Item 1');
    });

    it('fails open when states API returns unparseable JSON', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([1]),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [createWorkItemDetail(1, 'Item 1', 'MyProject', 'User Story', 'Resolved')],
        }),
      });

      // States API response.json() throws
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => { throw new SyntaxError('Unexpected token'); },
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Item should be kept (not filtered out)
      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('User Story 1: Item 1');
    });

    it('fails open when states API returns response without value array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([1]),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [createWorkItemDetail(1, 'Item 1', 'MyProject', 'User Story', 'CustomState')],
        }),
      });

      // States API returns valid JSON but no value array
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ count: 0 }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Item should be kept (fail open — no value array means no filtering)
      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('User Story 1: Item 1');
    });

    it('fails open when states API returns null value', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([1]),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [createWorkItemDetail(1, 'Item 1', 'MyProject', 'User Story', 'CustomState')],
        }),
      });

      // States API returns null value
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ count: 0, value: null }),
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Item should be kept (fail open)
      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
    });

    it('handles org-level query (no project)', async () => {
      provider.dispose();
      provider = new AdoWorkItemProvider([{ org: 'myorg', projects: [] }]); // Empty projects array
      mockAuthSession();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([1]),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [createWorkItemDetail(1, 'Item 1', 'SomeProject', 'User Story', 'Active')],
        }),
      });

      // States API for User Story
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createStatesResponse([
          { name: 'Active', category: 'InProgress' },
          { name: 'Resolved', category: 'Resolved' },
        ]),
      });

      await provider.refresh();

      // Verify states API URL doesn't have double-slash or missing project segment
      const statesApiCall = mockFetch.mock.calls.find((call: any) => 
        call[0].includes('workitemtypes') && call[0].includes('/states')
      );
      expect(statesApiCall).toBeDefined();
      const statesUrl = statesApiCall![0] as string;
      // Should use the project from work item detail (SomeProject), not from provider config
      expect(statesUrl).toContain('SomeProject');
      // Check for path segment issues (like '//_apis' or 'myorg//_apis')
      expect(statesUrl).not.toMatch(/[^:]\/\//);
    });
  });

  describe('batch fetching', () => {
    it('fetches work item details in batches of 200', async () => {
      // Generate 450 work item IDs to force 3 batches: 200 + 200 + 50
      const ids = Array.from({ length: 450 }, (_, i) => i + 1);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => createWiqlResponse(ids),
        })
        // Batch 1: IDs 1-200
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: ids.slice(0, 200).map(id => createWorkItemDetail(id, `Item ${id}`)),
          }),
        })
        // Batch 2: IDs 201-400
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: ids.slice(200, 400).map(id => createWorkItemDetail(id, `Item ${id}`)),
          }),
        })
        // Batch 3: IDs 401-450
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: ids.slice(400).map(id => createWorkItemDetail(id, `Item ${id}`)),
          }),
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // 1 WIQL + 3 batch detail calls + 1 states call (User Story)
      expect(mockFetch).toHaveBeenCalledTimes(5);

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(450);
    });

    it('continues fetching remaining batches when one batch fails', async () => {
      const ids = Array.from({ length: 250 }, (_, i) => i + 1);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => createWiqlResponse(ids),
        })
        // Batch 1 fails
        .mockResolvedValueOnce({ ok: false, status: 500 })
        // Batch 2 succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: ids.slice(200).map(id => createWorkItemDetail(id, `Item ${id}`)),
          }),
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Should still return items from successful batch
      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(50);
    });

    it('reports failure when any batch fails but still returns successful results', async () => {
      const ids = Array.from({ length: 250 }, (_, i) => i + 1);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => createWiqlResponse(ids),
        })
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: ids.slice(200).map(id => createWorkItemDetail(id, `Item ${id}`)),
          }),
        });

      await provider.refresh();

      // User-triggered refresh should show warning when batches fail
      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch work items'),
      );
    });
  });

  describe('malformed response handling', () => {
    it('handles malformed JSON from WIQL response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => { throw new SyntaxError('Unexpected token'); },
      });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      expect(listener).toHaveBeenCalledWith([]);
    });

    it('handles malformed JSON from detail response', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => createWiqlResponse([1, 2]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => { throw new SyntaxError('Unexpected token'); },
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Should fire with empty items since detail parse failed
      expect(listener).toHaveBeenCalledWith([]);
    });
  });

  describe('network errors', () => {
    it('handles fetch throwing a network error on WIQL call', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);

      // Should not throw
      await expect(provider.refresh()).resolves.toBeUndefined();
    });

    it('handles fetch throwing on detail call', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => createWiqlResponse([1]),
        })
        .mockRejectedValueOnce(new TypeError('Network timeout'));

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      // Promise.allSettled catches the rejection, so items fire (empty from failure)
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('multiple projects', () => {
    it('fetches work items for each configured project', async () => {
      provider.dispose();
      provider = new AdoWorkItemProvider([{ org: 'myorg', projects: ['ProjectA', 'ProjectB'] }]);
      mockAuthSession();

      // ProjectA WIQL + detail
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => createWiqlResponse([1]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => createWiqlResponse([2]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: [createWorkItemDetail(1, 'Item A', 'ProjectA')],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: [createWorkItemDetail(2, 'Item B', 'ProjectB')],
          }),
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(2);
    });

    it('reports multiple project failures', async () => {
      provider.dispose();
      provider = new AdoWorkItemProvider([{ org: 'myorg', projects: ['ProjectA', 'ProjectB'] }]);
      mockAuthSession();

      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 403 })
        .mockResolvedValueOnce({ ok: false, status: 403 });

      await provider.refresh();

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('2 sources'),
      );
    });

    it('handles mix of successful and failed project fetches', async () => {
      provider.dispose();
      provider = new AdoWorkItemProvider([{ org: 'myorg', projects: ['GoodProject', 'BadProject'] }]);
      mockAuthSession();

      // GoodProject: success
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => createWiqlResponse([1]),
        })
        // BadProject: fail
        .mockResolvedValueOnce({ ok: false, status: 404 })
        // GoodProject detail
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: [createWorkItemDetail(1, 'Good item', 'GoodProject')],
          }),
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items).toHaveLength(1);
      expect(items[0].group).toBe('myorg/GoodProject');

      // Should warn about the failed project
      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('BadProject'),
      );
    });
  });

  describe('concurrency guard', () => {
    it('skips concurrent refresh when already refreshing', async () => {
      let resolveFirstFetch: () => void;
      const firstFetchPromise = new Promise<void>(resolve => {
        resolveFirstFetch = resolve;
      });

      mockFetch.mockImplementationOnce(async () => {
        await firstFetchPromise;
        return {
          ok: true,
          json: async () => createWiqlResponse([]),
        };
      });

      // Start first refresh (will block on fetch)
      const first = provider.refresh();

      // Start second refresh while first is in progress
      const second = provider.refresh();

      // Unblock first
      resolveFirstFetch!();
      await first;
      await second;

      // Only one fetch call should have been made
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('work item mapping edge cases', () => {
    it('handles work item with undefined description', async () => {
      const item = createWorkItemDetail(1, 'No desc');
      item.fields['System.Description'] = undefined as any;

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => createWiqlResponse([1]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [item] }),
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items[0].description).toBeUndefined();
    });

    it('handles work item with empty description', async () => {
      const item = createWorkItemDetail(1, 'Empty desc');
      item.fields['System.Description'] = '';

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => createWiqlResponse([1]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [item] }),
        });

      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      await provider.refresh();

      const items = listener.mock.calls[0][0];
      expect(items[0].description).toBeUndefined();
    });
  });

  describe('periodic refresh edge cases', () => {
    it('clamps intervals below 60 to 60 seconds', () => {
      vi.useFakeTimers();

      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
      provider.startPeriodicRefresh(10);

      // At 10 seconds, should NOT have fired (clamped to 60)
      vi.advanceTimersByTime(10_000);
      expect(refreshSpy).not.toHaveBeenCalled();

      // At 60 seconds, should fire
      vi.advanceTimersByTime(50_000);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('does not start timer for zero interval', () => {
      vi.useFakeTimers();

      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
      provider.startPeriodicRefresh(0);

      vi.advanceTimersByTime(300_000);
      expect(refreshSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('does not start timer for negative interval', () => {
      vi.useFakeTimers();

      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
      provider.startPeriodicRefresh(-100);

      vi.advanceTimersByTime(300_000);
      expect(refreshSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('does not start timer for NaN interval', () => {
      vi.useFakeTimers();

      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);
      provider.startPeriodicRefresh(NaN);

      vi.advanceTimersByTime(300_000);
      expect(refreshSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('replaces existing timer when startPeriodicRefresh is called again', () => {
      vi.useFakeTimers();

      const refreshSpy = vi.spyOn(provider as any, 'refreshInBackground').mockResolvedValue(undefined);

      // Start with 60s interval
      provider.startPeriodicRefresh(60);
      // Replace with 120s interval
      provider.startPeriodicRefresh(120);

      // At 60s, the old timer would have fired but it was replaced
      vi.advanceTimersByTime(60_000);
      expect(refreshSpy).not.toHaveBeenCalled();

      // At 120s, the new timer fires
      vi.advanceTimersByTime(60_000);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  describe('background refresh', () => {
    it('uses createIfNone: false for background refresh', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([]),
      });

      const refreshBg = (provider as any).refreshInBackground.bind(provider);
      await refreshBg();

      expect(authentication.getSession).toHaveBeenCalledWith(
        'microsoft',
        ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        { createIfNone: false },
      );
    });

    it('checks for a cached session before prompting on user-triggered refresh', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createWiqlResponse([]),
      });

      await provider.refresh();

      expect(authentication.getSession).toHaveBeenCalledWith(
        'microsoft',
        ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        { silent: true },
      );
    });
  });

  describe('detail URL construction', () => {
    it('constructs correct detail URL with comma-separated IDs', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => createWiqlResponse([10, 20, 30]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: [
              createWorkItemDetail(10, 'A'),
              createWorkItemDetail(20, 'B'),
              createWorkItemDetail(30, 'C'),
            ],
          }),
        });

      await provider.refresh();

      const detailUrl = mockFetch.mock.calls[1][0] as string;
      expect(detailUrl).toContain('ids=10,20,30');
      expect(detailUrl).toContain('api-version=7.1');
      expect(detailUrl).toContain('fields=System.Title,System.Description,System.TeamProject,System.WorkItemType,System.State');
    });
  });
});
