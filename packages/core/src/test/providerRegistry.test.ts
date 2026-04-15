import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'vscode';
import { DevDocketProvider, DiscoveredItem } from '../api/types';
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

function createMockProvider(id: string): DevDocketProvider & { fireItems: (items: DiscoveredItem[]) => void } {
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

  describe('getProviderLabel with label cache', () => {
    function createMockLabelCache(entries?: Record<string, string>) {
      const cache = new Map<string, string>(Object.entries(entries ?? {}));
      return {
        get: vi.fn((id: string) => cache.get(id)),
        set: vi.fn(async (id: string, label: string) => { cache.set(id, label); }),
        load: vi.fn(async () => {}),
      };
    }

    it('falls back to cached label when provider is not registered', () => {
      const labelCache = createMockLabelCache({ github: 'GitHub Issues' });
      const reg = new ProviderRegistry(stateStore, labelCache as any);

      expect(reg.getProviderLabel('github')).toBe('GitHub Issues');
    });

    it('returns raw id when neither provider nor cache has label', () => {
      const labelCache = createMockLabelCache();
      const reg = new ProviderRegistry(stateStore, labelCache as any);

      expect(reg.getProviderLabel('unknown')).toBe('unknown');
    });

    it('prefers live provider label over cached label', () => {
      const labelCache = createMockLabelCache({ gh: 'Old Label' });
      const reg = new ProviderRegistry(stateStore, labelCache as any);
      const provider = createMockProvider('gh'); // label is "Provider gh"
      reg.register(provider);

      expect(reg.getProviderLabel('gh')).toBe('Provider gh');
    });

    it('updates cache when provider registers', () => {
      const labelCache = createMockLabelCache();
      const reg = new ProviderRegistry(stateStore, labelCache as any);
      const provider = createMockProvider('gh');
      reg.register(provider);

      expect(labelCache.set).toHaveBeenCalledWith('gh', 'Provider gh');
    });

    it('works without a label cache (undefined)', () => {
      const reg = new ProviderRegistry(stateStore);
      expect(reg.getProviderLabel('unknown')).toBe('unknown');
    });
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

  describe('loading state and registration race conditions', () => {
    // Schedules a macrotask via setTimeout; before it fires, the JS event loop
    // flushes all pending microtasks (promise .then/.catch/.finally chains).
    function nextTick(): Promise<void> {
      return new Promise(resolve => setTimeout(resolve, 0));
    }

    function createDeferredProvider(id: string) {
      let resolveRefresh!: () => void;
      let rejectRefresh!: (err: Error) => void;
      const refreshPromise = new Promise<void>((resolve, reject) => {
        resolveRefresh = resolve;
        rejectRefresh = reject;
      });
      const emitter = new EventEmitter<DiscoveredItem[]>();
      const provider: DevDocketProvider & { fireItems: (items: DiscoveredItem[]) => void } = {
        id,
        label: `Provider ${id}`,
        onDidDiscoverItems: emitter.event,
        refresh: vi.fn(() => refreshPromise),
        fireItems: (items) => emitter.fire(items),
      };
      return { provider, resolveRefresh, rejectRefresh };
    }

    it('loading is true immediately after register and false after immediately-resolved refresh', async () => {
      const provider = createMockProvider('sync');
      registry.register(provider);

      // loading is true synchronously after register (microtask hasn't run yet)
      expect(registry.loading).toBe(true);

      // After microtasks flush, the .finally() runs and loading becomes false
      await nextTick();
      expect(registry.loading).toBe(false);
    });

    it('loading becomes false after refresh rejects synchronously', async () => {
      const provider = createMockProvider('fail-sync');
      vi.mocked(provider.refresh).mockImplementation(() => Promise.reject(new Error('boom')));

      registry.register(provider);
      expect(registry.loading).toBe(true);

      await nextTick();
      expect(registry.loading).toBe(false);
    });

    it('loading stays true during async refresh until it completes', async () => {
      const { provider, resolveRefresh } = createDeferredProvider('async');
      registry.register(provider);

      expect(registry.loading).toBe(true);

      // Even after flushing microtasks, loading remains true because refresh hasn't resolved
      await nextTick();
      expect(registry.loading).toBe(true);

      resolveRefresh();
      await nextTick();
      expect(registry.loading).toBe(false);
    });

    it('loading stays true during async refresh until it rejects', async () => {
      const { provider, rejectRefresh } = createDeferredProvider('async-fail');
      registry.register(provider);

      expect(registry.loading).toBe(true);

      rejectRefresh(new Error('network error'));
      await nextTick();
      expect(registry.loading).toBe(false);
    });

    it('loading is true until both providers finish when two are registered simultaneously', async () => {
      const d1 = createDeferredProvider('p1');
      const d2 = createDeferredProvider('p2');

      registry.register(d1.provider);
      registry.register(d2.provider);

      expect(registry.loading).toBe(true);

      // Resolve only the first provider
      d1.resolveRefresh();
      await nextTick();
      // Still loading because p2 hasn't resolved
      expect(registry.loading).toBe(true);

      // Resolve the second provider
      d2.resolveRefresh();
      await nextTick();
      expect(registry.loading).toBe(false);
    });

    it('provider fires onDidDiscoverItems before refresh resolves — loading is still true', async () => {
      const { provider, resolveRefresh } = createDeferredProvider('race');

      let callbackCount = 0;
      let loadingDuringProviderEvent: boolean | undefined;
      const providerEventObserved = new Promise<void>((resolve) => {
        registry.onDidChangeDiscoveredItems(() => {
          callbackCount += 1;
          if (callbackCount === 2) {
            loadingDuringProviderEvent = registry.loading;
            resolve();
          }
        });
      });

      registry.register(provider);

      // Provider fires items while refresh is still pending
      provider.fireItems([{ externalId: '1', title: 'Item' }]);
      await providerEventObserved;

      // Verify the event caused by provider.fireItems(...) happened before refresh resolved
      expect(loadingDuringProviderEvent).toBe(true);

      resolveRefresh();
      await nextTick();
      expect(registry.loading).toBe(false);
    });

    it('onDidChangeDiscoveredItems fires when loading state transitions to false', async () => {
      const { provider, resolveRefresh } = createDeferredProvider('notif');

      const events: boolean[] = [];
      registry.onDidChangeDiscoveredItems(() => {
        events.push(registry.loading);
      });

      registry.register(provider);
      // Register fires onDidChangeDiscoveredItems with loading=true
      expect(events).toContain(true);

      resolveRefresh();
      await nextTick();
      // The .finally() fires onDidChangeDiscoveredItems with loading=false
      expect(events).toContain(false);
    });

    it('hasProviders is true after register and false after dispose', () => {
      expect(registry.hasProviders).toBe(false);

      const provider = createMockProvider('hp');
      const disposable = registry.register(provider);
      expect(registry.hasProviders).toBe(true);

      disposable.dispose();
      expect(registry.hasProviders).toBe(false);
    });

    it('hasProviders reflects multiple providers correctly', () => {
      const d1 = registry.register(createMockProvider('a'));
      const d2 = registry.register(createMockProvider('b'));

      expect(registry.hasProviders).toBe(true);

      d1.dispose();
      expect(registry.hasProviders).toBe(true);

      d2.dispose();
      expect(registry.hasProviders).toBe(false);
    });

    it('dispose clears loading state for in-flight provider', () => {
      const { provider } = createDeferredProvider('inflight');
      const disposable = registry.register(provider);

      expect(registry.loading).toBe(true);

      disposable.dispose();
      expect(registry.loading).toBe(false);
      expect(registry.hasProviders).toBe(false);
    });
  });

  describe('rapid updates', () => {
    it('handles rapid item fires from the same provider', async () => {
      const provider = createMockProvider('rapid');
      registry.register(provider);

      // Fire items rapidly in succession
      provider.fireItems([{ externalId: '1', title: 'First' }]);
      provider.fireItems([{ externalId: '2', title: 'Second' }]);
      provider.fireItems([{ externalId: '3', title: 'Third' }]);

      // Last fire wins — items are replaced, not accumulated
      await vi.waitFor(() => {
        const items = registry.getDiscoveredItems('rapid');
        expect(items).toHaveLength(1);
        expect(items[0].externalId).toBe('3');
      });
    });

    it('fires onDidChangeDiscoveredItems for each rapid update', async () => {
      const provider = createMockProvider('rapid');
      registry.register(provider);

      // Wait for registration/refresh to fully complete
      await vi.waitFor(() => expect(registry.loading).toBe(false));

      const listener = vi.fn();
      registry.onDidChangeDiscoveredItems(listener);

      provider.fireItems([{ externalId: '1', title: 'A' }]);
      provider.fireItems([{ externalId: '2', title: 'B' }]);

      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    });

    it('handles interleaved fires from multiple providers', async () => {
      const p1 = createMockProvider('alpha');
      const p2 = createMockProvider('beta');
      registry.register(p1);
      registry.register(p2);

      p1.fireItems([{ externalId: 'a1', title: 'Alpha 1' }]);
      p2.fireItems([{ externalId: 'b1', title: 'Beta 1' }]);
      p1.fireItems([{ externalId: 'a2', title: 'Alpha 2' }]);

      await vi.waitFor(() => {
        expect(registry.getDiscoveredItems('alpha')).toHaveLength(1);
        expect(registry.getDiscoveredItems('alpha')[0].externalId).toBe('a2');
        expect(registry.getDiscoveredItems('beta')).toHaveLength(1);
        expect(registry.getDiscoveredItems('beta')[0].externalId).toBe('b1');
      });
    });

    it('correctly counts new unseen items across rapid fires', async () => {
      const provider = createMockProvider('rapid');
      registry.register(provider);

      const unseenListener = vi.fn();
      registry.onDidAddNewUnseenItems(unseenListener);

      // Rapid fires — each produces a new unseen item
      provider.fireItems([{ externalId: '1', title: 'One' }]);
      provider.fireItems([{ externalId: '2', title: 'Two' }]);
      provider.fireItems([{ externalId: '3', title: 'Three' }]);

      // Each fire triggers handleDiscoveredItems, so unseenListener fires per batch
      await vi.waitFor(() => expect(unseenListener).toHaveBeenCalledTimes(3));
      // Each call should report exactly 1 new unseen item
      expect(unseenListener).toHaveBeenNthCalledWith(1, 1);
      expect(unseenListener).toHaveBeenNthCalledWith(2, 1);
      expect(unseenListener).toHaveBeenNthCalledWith(3, 1);
    });
  });

  describe('edge cases', () => {
    it('handles empty items array from provider', async () => {
      const provider = createMockProvider('empty');
      registry.register(provider);

      // Wait for initial refresh to complete so we isolate the empty-fire behavior
      await vi.waitFor(() => expect(registry.loading).toBe(false));

      stateStore.setStates.mockClear();
      const changeListener = vi.fn();
      registry.onDidChangeDiscoveredItems(changeListener);

      provider.fireItems([]);

      await vi.waitFor(() => expect(changeListener).toHaveBeenCalled());
      expect(registry.getDiscoveredItems('empty')).toEqual([]);
      // No unseen items to set
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('deregistration clears discovered items', () => {
      const provider = createMockProvider('clearme');
      const disposable = registry.register(provider);

      provider.fireItems([{ externalId: '1', title: 'Item' }]);
      expect(registry.getDiscoveredItems('clearme')).toHaveLength(1);

      disposable.dispose();
      expect(registry.getDiscoveredItems('clearme')).toEqual([]);
    });

    it('deregistration removes loading state', async () => {
      const provider = createMockProvider('loadclear');
      // Make refresh hang
      provider.refresh = vi.fn(() => new Promise(() => {}));
      const disposable = registry.register(provider);

      expect(registry.loading).toBe(true);
      disposable.dispose();
      expect(registry.loading).toBe(false);
    });

    it('fires onDidChangeDiscoveredItems on deregistration', async () => {
      const provider = createMockProvider('notify');
      const disposable = registry.register(provider);

      // Wait for initial refresh to complete
      await vi.waitFor(() => expect(registry.loading).toBe(false));

      const listener = vi.fn();
      registry.onDidChangeDiscoveredItems(listener);

      disposable.dispose();

      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    });

    it('fires onDidRegisterProvider on registration', () => {
      const listener = vi.fn();
      registry.onDidRegisterProvider(listener);

      registry.register(createMockProvider('notifyreg'));
      expect(listener).toHaveBeenCalledTimes(1);
    });
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

      await vi.advanceTimersByTimeAsync(ProviderRegistry.REFRESH_TIMEOUT_MS);
      expect(registry.loading).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Provider "slow" refresh timed out'),
      );
      warnSpy.mockRestore();
    });

    it('resolves refreshAll when a provider refresh times out', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const provider = createMockProvider('hanging');
      registry.register(provider);

      vi.mocked(provider.refresh).mockReturnValue(new Promise(() => {}));

      const refreshPromise = registry.refreshAll();
      expect(warnSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(ProviderRegistry.REFRESH_TIMEOUT_MS);
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

      await vi.advanceTimersByTimeAsync(ProviderRegistry.REFRESH_TIMEOUT_MS);
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

      await vi.advanceTimersByTimeAsync(ProviderRegistry.REFRESH_TIMEOUT_MS);
      expect(receivedToken.isCancellationRequested).toBe(true);
    });
  });

  describe('item cap (MAX_ITEMS_PER_PROVIDER)', () => {
    function makeItems(count: number): DiscoveredItem[] {
      return Array.from({ length: count }, (_, i) => ({
        externalId: `item-${i}`,
        title: `Item ${i}`,
      }));
    }

    it('accepts all items when count equals MAX_ITEMS_PER_PROVIDER', async () => {
      const provider = createMockProvider('exact-cap');
      registry.register(provider);

      const items = makeItems(ProviderRegistry.MAX_ITEMS_PER_PROVIDER);
      provider.fireItems(items);

      await vi.waitFor(() => {
        const stored = registry.getDiscoveredItems('exact-cap');
        expect(stored).toHaveLength(ProviderRegistry.MAX_ITEMS_PER_PROVIDER);
      });
    });

    it('truncates items exceeding MAX_ITEMS_PER_PROVIDER', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const provider = createMockProvider('over-cap');
      registry.register(provider);

      const excess = 50;
      const items = makeItems(ProviderRegistry.MAX_ITEMS_PER_PROVIDER + excess);
      provider.fireItems(items);

      await vi.waitFor(() => {
        const stored = registry.getDiscoveredItems('over-cap');
        expect(stored).toHaveLength(ProviderRegistry.MAX_ITEMS_PER_PROVIDER);
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`emitted ${ProviderRegistry.MAX_ITEMS_PER_PROVIDER + excess} items`),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Truncating'),
      );
      warnSpy.mockRestore();
    });

    it('accepts 0 items without truncation or warning', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const provider = createMockProvider('zero-items');
      registry.register(provider);
      await vi.waitFor(() => expect(registry.loading).toBe(false));
      warnSpy.mockClear();

      provider.fireItems([]);

      await vi.waitFor(() => {
        expect(registry.getDiscoveredItems('zero-items')).toEqual([]);
      });
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Truncating'),
      );
      warnSpy.mockRestore();
    });

    it('preserves order of first N items after truncation', async () => {
      const provider = createMockProvider('order-check');
      registry.register(provider);

      const items = makeItems(ProviderRegistry.MAX_ITEMS_PER_PROVIDER + 100);
      provider.fireItems(items);

      await vi.waitFor(() => {
        const stored = registry.getDiscoveredItems('order-check');
        expect(stored).toHaveLength(ProviderRegistry.MAX_ITEMS_PER_PROVIDER);
        // First and last retained items match original order
        expect(stored[0].externalId).toBe('item-0');
        expect(stored[ProviderRegistry.MAX_ITEMS_PER_PROVIDER - 1].externalId)
          .toBe(`item-${ProviderRegistry.MAX_ITEMS_PER_PROVIDER - 1}`);
      });
    });

    it('excess items are excluded from discovered items after cap', async () => {
      const provider = createMockProvider('truncated-only');
      registry.register(provider);

      const excess = 25;
      const total = ProviderRegistry.MAX_ITEMS_PER_PROVIDER + excess;
      const items = makeItems(total);
      provider.fireItems(items);

      await vi.waitFor(() => {
        const stored = registry.getDiscoveredItems('truncated-only');
        expect(stored).toHaveLength(ProviderRegistry.MAX_ITEMS_PER_PROVIDER);
        // None of the excess items should be present
        const ids = new Set(stored.map(i => i.externalId));
        for (let i = ProviderRegistry.MAX_ITEMS_PER_PROVIDER; i < total; i++) {
          expect(ids.has(`item-${i}`)).toBe(false);
        }
      });
    });

    it('does not warn when items are at or below the cap', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const provider = createMockProvider('under-cap');
      registry.register(provider);
      await vi.waitFor(() => expect(registry.loading).toBe(false));
      warnSpy.mockClear();

      provider.fireItems(makeItems(ProviderRegistry.MAX_ITEMS_PER_PROVIDER));

      await vi.waitFor(() => {
        expect(registry.getDiscoveredItems('under-cap')).toHaveLength(
          ProviderRegistry.MAX_ITEMS_PER_PROVIDER,
        );
      });
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Truncating'),
      );
      warnSpy.mockRestore();
    });

    it('stores a defensive copy so later mutations to the original array do not affect the registry', async () => {
      const provider = createMockProvider('defensive-copy');
      registry.register(provider);
      await vi.waitFor(() => expect(registry.loading).toBe(false));

      const items = makeItems(3);
      provider.fireItems(items);

      await vi.waitFor(() => {
        expect(registry.getDiscoveredItems('defensive-copy')).toHaveLength(3);
      });

      // Mutate the original array after it was stored
      items.push({ externalId: 'sneaky', title: 'Sneaky' });

      // The registry should still have only 3 items
      expect(registry.getDiscoveredItems('defensive-copy')).toHaveLength(3);
    });
  });

  describe('health tracking', () => {
    function nextTick(): Promise<void> {
      return new Promise(resolve => setTimeout(resolve, 0));
    }

    function createDeferredProvider(id: string) {
      let resolveRefresh!: () => void;
      let rejectRefresh!: (err: Error) => void;
      const refreshPromise = new Promise<void>((resolve, reject) => {
        resolveRefresh = resolve;
        rejectRefresh = reject;
      });
      const emitter = new EventEmitter<DiscoveredItem[]>();
      const provider: DevDocketProvider & { fireItems: (items: DiscoveredItem[]) => void } = {
        id,
        label: `Provider ${id}`,
        onDidDiscoverItems: emitter.event,
        refresh: vi.fn(() => refreshPromise),
        fireItems: (items) => emitter.fire(items),
      };
      return { provider, resolveRefresh, rejectRefresh };
    }

    it('reports unknown health before first refresh completes', () => {
      const { provider } = createDeferredProvider('pending');
      registry.register(provider);
      expect(registry.getProviderHealth('pending')).toEqual({ status: 'unknown' });
    });

    it('sets healthy status after successful refresh', async () => {
      const { provider, resolveRefresh } = createDeferredProvider('ok');
      registry.register(provider);

      resolveRefresh();
      await nextTick();

      const health = registry.getProviderHealth('ok');
      expect(health.status).toBe('healthy');
      expect(health.lastRefreshTime).toBeInstanceOf(Date);
      expect(health.lastError).toBeUndefined();
    });

    it('sets unhealthy status with error message after failed refresh', async () => {
      const { provider, rejectRefresh } = createDeferredProvider('fail');
      registry.register(provider);

      rejectRefresh(new Error('network error'));
      await nextTick();

      const health = registry.getProviderHealth('fail');
      expect(health.status).toBe('unhealthy');
      expect(health.lastError).toBe('network error');
    });

    it('sets unhealthy status on timeout', async () => {
      vi.useFakeTimers();
      try {
        const neverResolve = new Promise<void>(() => {});
        const emitter = new EventEmitter<DiscoveredItem[]>();
        const provider: DevDocketProvider = {
          id: 'slow',
          label: 'Slow Provider',
          onDidDiscoverItems: emitter.event,
          refresh: vi.fn(() => neverResolve),
        };
        registry.register(provider);

        // Advance past the timeout
        vi.advanceTimersByTime(ProviderRegistry.REFRESH_TIMEOUT_MS + 100);
        await vi.runAllTimersAsync();

        const health = registry.getProviderHealth('slow');
        expect(health.status).toBe('unhealthy');
        expect(health.lastError).toBe('Refresh timed out');
      } finally {
        vi.useRealTimers();
      }
    });

    it('fires onDidChangeProviderHealth on status change', async () => {
      const { provider, resolveRefresh } = createDeferredProvider('evented');
      registry.register(provider);

      const listener = vi.fn();
      registry.onDidChangeProviderHealth(listener);

      resolveRefresh();
      await nextTick();

      expect(listener).toHaveBeenCalledWith('evented');
    });

    it('fires onDidChangeProviderHealth when lastRefreshTime changes even if status is same', async () => {
      const provider = createMockProvider('stable');
      registry.register(provider);
      // First refresh resolves immediately → healthy
      await nextTick();

      const listener = vi.fn();
      registry.onDidChangeProviderHealth(listener);

      // Trigger another refresh — also resolves immediately → healthy again
      // but lastRefreshTime changes, so the event should fire
      await registry.refreshAll();

      expect(listener).toHaveBeenCalledWith('stable');
    });

    it('clears health status when provider is unregistered', async () => {
      const provider = createMockProvider('temp');
      const disposable = registry.register(provider);
      await nextTick();

      expect(registry.getProviderHealth('temp').status).toBe('healthy');

      disposable.dispose();
      expect(registry.getProviderHealth('temp')).toEqual({ status: 'unknown' });
    });

    it('preserves lastRefreshTime from previous healthy state on failure', async () => {
      const provider = createMockProvider('flaky');
      registry.register(provider);
      await nextTick();

      const healthyTime = registry.getProviderHealth('flaky').lastRefreshTime;
      expect(healthyTime).toBeInstanceOf(Date);

      // Now trigger a failed refresh
      vi.mocked(provider.refresh).mockRejectedValueOnce(new Error('oops'));
      await registry.refreshAll();

      const health = registry.getProviderHealth('flaky');
      expect(health.status).toBe('unhealthy');
      expect(health.lastError).toBe('oops');
      // lastRefreshTime is preserved from the last healthy refresh
      expect(health.lastRefreshTime).toEqual(healthyTime);
    });
  });
});
