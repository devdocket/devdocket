import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'vscode';
import { WorkCenterProvider, DiscoveredItem } from '../api/types';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import { logger } from '../services/logger';
import { ITaskStore } from '../storage/taskStore';
import { WorkItemState } from '../models/workItem';

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    saveAll: vi.fn(async (batch) => { for (const item of batch) { items.set(item.id, item); } }),
    delete: vi.fn(async (id) => { items.delete(id); }),
  };
}

function createMockStateStore() {
  const cache = new Map<string, string>();
  return {
    getState: vi.fn((providerId: string, externalId: string) =>
      cache.get(`${providerId}::${externalId}`) as any,
    ),
    setState: vi.fn(async (providerId: string, externalId: string, state: string) => {
      cache.set(`${providerId}::${externalId}`, state);
    }),
    setStates: vi.fn(async (items: Array<{ providerId: string; externalId: string; state: string }>) => {
      for (const item of items) {
        cache.set(`${item.providerId}::${item.externalId}`, item.state);
      }
    }),
    load: vi.fn(async () => {}),
    loadAll: vi.fn(async () => []),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    _set: (providerId: string, externalId: string, state: string) => {
      cache.set(`${providerId}::${externalId}`, state);
    },
  };
}

function createMockProvider(id: string): WorkCenterProvider & { fireItems: (items: DiscoveredItem[]) => void } {
  const emitter = new EventEmitter<DiscoveredItem[]>();
  return {
    id,
    label: `Provider ${id}`,
    onDidDiscoverItems: emitter.event,
    refresh: vi.fn(async () => {}),
    fireItems: (items) => emitter.fire(items),
  };
}

describe('ProviderRegistry', () => {
  let store: ITaskStore;
  let graph: WorkGraph;
  let stateStore: ReturnType<typeof createMockStateStore>;
  let registry: ProviderRegistry;

  beforeEach(async () => {
    store = createMockStore();
    graph = new WorkGraph(store);
    await graph.load();
    stateStore = createMockStateStore();
    registry = new ProviderRegistry(stateStore);
  });

  it('stores the provider and returns a Disposable on register', () => {
    const provider = createMockProvider('test');
    const disposable = registry.register(provider);

    expect(registry.getProvider('test')).toBe(provider);
    expect(disposable).toBeDefined();
    expect(typeof disposable.dispose).toBe('function');
  });

  it('throws on duplicate provider id', () => {
    const provider1 = createMockProvider('dup');
    const provider2 = createMockProvider('dup');

    registry.register(provider1);
    expect(() => registry.register(provider2)).toThrow('Provider already registered: dup');
  });

  it('calls provider.refresh() on registration', () => {
    const provider = createMockProvider('refresher');
    registry.register(provider);

    expect(provider.refresh).toHaveBeenCalledTimes(1);
  });

  it('removes the provider when the returned Disposable is disposed', () => {
    const provider = createMockProvider('removable');
    const disposable = registry.register(provider);

    expect(registry.getProvider('removable')).toBe(provider);
    disposable.dispose();
    expect(registry.getProvider('removable')).toBeUndefined();
  });

  it('returns registered provider from getProvider', () => {
    const provider = createMockProvider('findme');
    registry.register(provider);

    expect(registry.getProvider('findme')).toBe(provider);
  });

  it('returns undefined from getProvider for unknown id', () => {
    expect(registry.getProvider('nonexistent')).toBeUndefined();
  });

  it('stores discovered items in memory when provider fires onDidDiscoverItems', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    provider.fireItems([
      { externalId: 'issue-1', title: 'Bug fix', description: 'Fix the bug', url: 'https://github.com/issue/1' },
      { externalId: 'issue-2', title: 'Feature', url: 'https://github.com/issue/2' },
    ]);

    const items = registry.getDiscoveredItems('gh');
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Bug fix');
    expect(items[0].externalId).toBe('issue-1');
    expect(items[1].title).toBe('Feature');
  });

  it('replaces discovered items on re-discovery', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    provider.fireItems([
      { externalId: 'issue-1', title: 'Original title', description: 'Original desc' },
    ]);

    expect(registry.getDiscoveredItems('gh')).toHaveLength(1);

    provider.fireItems([
      { externalId: 'issue-1', title: 'Updated title', description: 'Updated desc' },
    ]);

    const items = registry.getDiscoveredItems('gh');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Updated title');
    expect(items[0].description).toBe('Updated desc');
  });

  it('calls refresh on all registered providers via refreshAll', async () => {
    const p1 = createMockProvider('p1');
    const p2 = createMockProvider('p2');
    registry.register(p1);
    registry.register(p2);

    // Reset call counts from registration refresh
    vi.mocked(p1.refresh).mockClear();
    vi.mocked(p2.refresh).mockClear();

    await registry.refreshAll();

    expect(p1.refresh).toHaveBeenCalledTimes(1);
    expect(p2.refresh).toHaveBeenCalledTimes(1);
  });

  it('handles refresh errors gracefully in refreshAll', async () => {
    const p1 = createMockProvider('p1');
    vi.mocked(p1.refresh).mockRejectedValueOnce(new Error('network error'));
    registry.register(p1);
    vi.mocked(p1.refresh).mockClear();
    vi.mocked(p1.refresh).mockRejectedValueOnce(new Error('network error'));

    // Should not throw
    await expect(registry.refreshAll()).resolves.toBeUndefined();
  });

  it('cleans up all subscriptions on dispose', () => {
    const p1 = createMockProvider('p1');
    const p2 = createMockProvider('p2');
    registry.register(p1);
    registry.register(p2);

    registry.dispose();

    expect(registry.getProvider('p1')).toBeUndefined();
    expect(registry.getProvider('p2')).toBeUndefined();
  });

  it('sets unseen state for newly discovered items', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    provider.fireItems([
      { externalId: 'issue-1', title: 'Bug fix' },
    ]);

    expect(stateStore.setStates).toHaveBeenCalledWith([
      { providerId: 'gh', externalId: 'issue-1', state: 'unseen' },
    ]);
  });

  it('does not overwrite existing state on re-discovery', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    // Simulate item already accepted
    stateStore.getState.mockReturnValueOnce('accepted');

    provider.fireItems([
      { externalId: 'issue-1', title: 'Bug fix' },
    ]);

    // setStates should not be called since state already exists
    expect(stateStore.setStates).not.toHaveBeenCalled();
  });

  it('returns provider label from getProviderLabel', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    expect(registry.getProviderLabel('gh')).toBe('Provider gh');
    expect(registry.getProviderLabel('unknown')).toBe('unknown');
  });

  it('returns empty array from getDiscoveredItems for unknown provider', () => {
    expect(registry.getDiscoveredItems('nonexistent')).toEqual([]);
  });

  it('returns full map from getAllDiscoveredItems with multiple providers', () => {
    const p1 = createMockProvider('gh');
    const p2 = createMockProvider('jira');
    registry.register(p1);
    registry.register(p2);

    p1.fireItems([{ externalId: '1', title: 'GH item' }]);
    p2.fireItems([{ externalId: '2', title: 'Jira item' }]);

    const all = registry.getAllDiscoveredItems();
    expect(all.size).toBe(2);
    expect(all.get('gh')).toHaveLength(1);
    expect(all.get('jira')).toHaveLength(1);
  });

  it('fires onDidAddNewUnseenItems with count of newly unseen items', async () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    const listener = vi.fn();
    registry.onDidAddNewUnseenItems(listener);

    provider.fireItems([
      { externalId: 'issue-1', title: 'Bug fix' },
      { externalId: 'issue-2', title: 'Feature' },
    ]);

    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(2));
  });

  it('does not fire onDidAddNewUnseenItems when no new unseen items', async () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    // Simulate items already accepted
    stateStore._set('gh', 'issue-1', 'accepted');

    const listener = vi.fn();
    registry.onDidAddNewUnseenItems(listener);

    provider.fireItems([
      { externalId: 'issue-1', title: 'Bug fix' },
    ]);

    // Wait for handleDiscoveredItems to complete by checking items are stored
    await vi.waitFor(() =>
      expect(registry.getDiscoveredItems('gh')).toHaveLength(1),
    );
    expect(stateStore.setStates).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('fires onDidChangeDiscoveredItems when provider discovers items', async () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    const listener = vi.fn();
    registry.onDidChangeDiscoveredItems(listener);

    provider.fireItems([{ externalId: '1', title: 'Item' }]);
    // handleDiscoveredItems is async, wait for it to settle
    // Event fires once for discovered items, and may fire again when loading clears
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    const firstCallCount = listener.mock.calls.length;

    provider.fireItems([{ externalId: '2', title: 'Another' }]);
    await vi.waitFor(() => expect(listener.mock.calls.length).toBeGreaterThan(firstCallCount));
  });

  it('keeps dismissed state when provider re-fires items', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    // First discovery — item gets 'unseen'
    provider.fireItems([{ externalId: 'issue-1', title: 'Bug' }]);
    expect(stateStore.setStates).toHaveBeenCalledWith([
      { providerId: 'gh', externalId: 'issue-1', state: 'unseen' },
    ]);

    stateStore.setStates.mockClear();
    // Simulate state is now 'dismissed'
    stateStore.getState.mockReturnValue('dismissed');

    // Provider re-fires the same item
    provider.fireItems([{ externalId: 'issue-1', title: 'Bug' }]);

    // Should NOT overwrite dismissed state
    expect(stateStore.setStates).not.toHaveBeenCalled();
  });

  it('does not create WorkItems on workGraph when provider fires', async () => {
    const createSpy = vi.spyOn(graph, 'createItem');
    const provider = createMockProvider('gh');
    registry.register(provider);

    provider.fireItems([{ externalId: '1', title: 'Discovered' }]);

    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });

  it('does not fire onDidAddNewUnseenItems when setStates fails', async () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    stateStore.setStates.mockRejectedValueOnce(new Error('disk full'));

    const listener = vi.fn();
    registry.onDidAddNewUnseenItems(listener);

    provider.fireItems([
      { externalId: 'issue-1', title: 'Bug fix' },
    ]);

    // Wait for handleDiscoveredItems to complete
    await vi.waitFor(() =>
      expect(registry.getDiscoveredItems('gh')).toHaveLength(1),
    );
    expect(listener).not.toHaveBeenCalled();
  });

  describe('refresh timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('clears loading state when register refresh times out', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const provider = createMockProvider('slow');
      vi.mocked(provider.refresh).mockReturnValue(new Promise(() => {}));

      registry.register(provider);
      expect(registry.loading).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(registry.loading).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Provider "slow" refresh timed out'),
      );
      warnSpy.mockRestore();
    });

    it('resolves refreshAll when a provider refresh times out', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const provider = createMockProvider('hanging');
      // Let register-time refresh complete so this test only observes the
      // timeout behavior from the refreshAll() invocation itself.
      registry.register(provider);

      // Make the refresh triggered by refreshAll() hang
      vi.mocked(provider.refresh).mockReturnValue(new Promise(() => {}));

      const refreshPromise = registry.refreshAll();
      expect(warnSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(refreshPromise).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Provider "hanging" refresh timed out'),
      );
      warnSpy.mockRestore();
    });

    it('clears timeout when refresh completes quickly', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const provider = createMockProvider('fast');
      registry.register(provider);

      // refresh already resolved (default mock is async () => {})
      // Advance past timeout — no spurious warnings should fire
      await vi.advanceTimersByTimeAsync(30_000);
      expect(registry.loading).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('passes CancellationToken to provider refresh', async () => {
      const provider = createMockProvider('tokencheck');
      registry.register(provider);

      expect(provider.refresh).toHaveBeenCalledWith(
        expect.objectContaining({ isCancellationRequested: false }),
      );
    });

    it('cancels the token when timeout fires', async () => {
      const provider = createMockProvider('cancel-test');
      let receivedToken: any;
      vi.mocked(provider.refresh).mockImplementation(async (token?: any) => {
        receivedToken = token;
        return new Promise(() => {});
      });

      registry.register(provider);
      expect(receivedToken).toBeDefined();
      expect(receivedToken.isCancellationRequested).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(receivedToken.isCancellationRequested).toBe(true);
    });
  });

  describe('resurfaceDismissed', () => {
    function createResurfaceProvider(id: string): WorkCenterProvider & { fireItems: (items: DiscoveredItem[]) => void } {
      const emitter = new EventEmitter<DiscoveredItem[]>();
      return {
        id,
        label: `Provider ${id}`,
        resurfaceDismissed: true,
        onDidDiscoverItems: emitter.event,
        refresh: vi.fn(async () => {}),
        fireItems: (items) => emitter.fire(items),
      };
    }

    it('resets dismissed items to unseen when resurfaceDismissed is true', async () => {
      const provider = createResurfaceProvider('pr-reviews');
      registry.register(provider);
      stateStore._set('pr-reviews', 'pr-1', 'dismissed');

      provider.fireItems([{ externalId: 'pr-1', title: 'Review PR' }]);
      await vi.waitFor(() => {
        expect(stateStore.setStates).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({ providerId: 'pr-reviews', externalId: 'pr-1', state: 'unseen' }),
          ]),
        );
      });
    });

    it('does NOT reset dismissed items when resurfaceDismissed is false', async () => {
      const provider = createMockProvider('issues');
      registry.register(provider);
      stateStore._set('issues', 'issue-1', 'dismissed');

      provider.fireItems([{ externalId: 'issue-1', title: 'Old issue' }]);
      // Wait for async handler to complete, then verify no state change for dismissed item
      await vi.waitFor(() => {
        const calls = stateStore.setStates.mock.calls;
        // If setStates was called, ensure it never included our dismissed item
        for (const call of calls) {
          const items = call[0] as Array<{ externalId: string }>;
          expect(items.find((i) => i.externalId === 'issue-1')).toBeUndefined();
        }
      });
    });

    it('does NOT reset accepted items even when resurfaceDismissed is true', async () => {
      const provider = createResurfaceProvider('pr-reviews');
      registry.register(provider);
      stateStore._set('pr-reviews', 'pr-1', 'accepted');

      provider.fireItems([{ externalId: 'pr-1', title: 'Accepted PR' }]);
      await vi.waitFor(() => {
        const calls = stateStore.setStates.mock.calls;
        for (const call of calls) {
          const items = call[0] as Array<{ externalId: string }>;
          expect(items.find((i) => i.externalId === 'pr-1')).toBeUndefined();
        }
      });
    });
  });
});
