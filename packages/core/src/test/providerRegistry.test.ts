import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CancellationTokenSource, EventEmitter } from 'vscode';
import { DevDocketProvider, ProviderItem } from '../api/types';
import type { WindowStateProvider } from '@devdocket/shared';
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
  const versions = new Map<string, string>();
  const resurfaceVersions = new Map<string, string>();
  return {
    getState: vi.fn((providerId: string, externalId: string) =>
      cache.get(`${providerId}::${externalId}`) as any,
    ),
    getVersion: vi.fn((providerId: string, externalId: string) =>
      versions.get(`${providerId}::${externalId}`),
    ),
    getResurfaceVersion: vi.fn((providerId: string, externalId: string) =>
      resurfaceVersions.get(`${providerId}::${externalId}`),
    ),
    setState: vi.fn(async (providerId: string, externalId: string, state: string, version?: string) => {
      cache.set(`${providerId}::${externalId}`, state);
      if (version !== undefined) {
        versions.set(`${providerId}::${externalId}`, version);
      }
    }),
    setStates: vi.fn(async (items: Array<{ providerId: string; externalId: string; state: string; version?: string; resurfaceVersion?: string }>) => {
      for (const item of items) {
        cache.set(`${item.providerId}::${item.externalId}`, item.state);
        if (item.version !== undefined) {
          versions.set(`${item.providerId}::${item.externalId}`, item.version);
        }
        if (item.resurfaceVersion !== undefined) {
          resurfaceVersions.set(`${item.providerId}::${item.externalId}`, item.resurfaceVersion);
        }
      }
    }),
    load: vi.fn(async () => {}),
    loadAll: vi.fn(async () => []),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    _set: (providerId: string, externalId: string, state: string) => {
      cache.set(`${providerId}::${externalId}`, state);
    },
    _setVersion: (providerId: string, externalId: string, version: string) => {
      versions.set(`${providerId}::${externalId}`, version);
    },
    _setResurfaceVersion: (providerId: string, externalId: string, rv: string) => {
      resurfaceVersions.set(`${providerId}::${externalId}`, rv);
    },
  };
}

function createMockProvider(id: string): DevDocketProvider & { fireItems: (items: ProviderItem[]) => void } {
  const emitter = new EventEmitter<ProviderItem[]>();
  return {
    id,
    label: `Provider ${id}`,
    onDidDiscoverItems: emitter.event,
    refresh: vi.fn(async () => {}),
    fireItems: (items) => emitter.fire(items),
  };
}

function createMockWindowState(isFocused = true): WindowStateProvider {
  return {
    isFocused,
    onDidChangeFocus: vi.fn(() => ({ dispose: vi.fn() })),
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

  it('exposes synthetic provider items registered from URL resolution', async () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    await vi.waitFor(() => expect(registry.loading).toBe(false));

    registry.registerSyntheticProviderItem('gh', {
      externalId: 'owner/repo#42',
      title: '#42: Imported PR',
      itemType: 'pr',
      capabilities: { gitWork: { kind: 'pr', cloneUrl: 'https://github.com/owner/repo.git', ref: 'feature/topic' } },
    });

    expect(registry.getProviderItems('gh')).toEqual([
      expect.objectContaining({ externalId: 'owner/repo#42', itemType: 'pr' }),
    ]);
    expect(registry.findProviderItem('gh', 'owner/repo#42')).toEqual(
      expect.objectContaining({ externalId: 'owner/repo#42' }),
    );
  });

  it('keeps synthetic items when only metadata fields like state or reason are present', async () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    await vi.waitFor(() => expect(registry.loading).toBe(false));

    registry.registerSyntheticResolvedItem('gh', {
      title: '#42: Imported PR',
      notes: '',
      url: 'https://example.com/42',
      externalId: 'owner/repo#42',
      providerId: 'gh',
      reason: 'review_requested',
      state: 'open',
    });

    expect(registry.findProviderItem('gh', 'owner/repo#42')).toEqual(
      expect.objectContaining({ externalId: 'owner/repo#42', reason: 'review_requested', state: 'open' }),
    );
  });

  it('prefers live provider items over synthetic URL-imported items with the same external id', async () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    await vi.waitFor(() => expect(registry.loading).toBe(false));

    registry.registerSyntheticProviderItem('gh', {
      externalId: 'owner/repo#42',
      title: '#42: Imported PR',
      itemType: 'pr',
      capabilities: { gitWork: { kind: 'pr', cloneUrl: 'https://github.com/owner/repo.git', ref: 'feature/topic' } },
    });
    provider.fireItems([{ externalId: 'owner/repo#42', title: '#42: Live PR' }]);

    await vi.waitFor(() => expect(registry.findProviderItem('gh', 'owner/repo#42')?.title).toBe('#42: Live PR'));
    expect(registry.getProviderItems('gh')).toEqual([
      expect.objectContaining({ externalId: 'owner/repo#42', title: '#42: Live PR' }),
    ]);
  });

  it('rehydrates synthetic URL-imported items for registered providers on startup', async () => {
    const provider = {
      ...createMockProvider('ado-pr-reviews'),
      resolveUrl: vi.fn(async () => ({
        title: '#42: Imported PR',
        notes: 'Imported notes',
        url: 'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42',
        externalId: 'myorg/MyProject/myrepo/42',
        providerId: 'ado-pr-reviews',
        itemType: 'pr' as const,
        capabilities: { gitWork: { kind: 'pr' as const, cloneUrl: 'https://myorg@dev.azure.com/myorg/MyProject/_git/myrepo', ref: 'users/me/fix' } },
      })),
    };
    const reg = new ProviderRegistry(
      stateStore,
      undefined,
      () => WorkItemState.InProgress,
      undefined,
      () => [{
        providerId: 'ado-pr-reviews',
        externalId: 'myorg/MyProject/myrepo/42',
        url: 'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42',
      }],
    );

    reg.register(provider);
    await vi.waitFor(() => expect(reg.findProviderItem('ado-pr-reviews', 'myorg/MyProject/myrepo/42')).toEqual(
      expect.objectContaining({ externalId: 'myorg/MyProject/myrepo/42', itemType: 'pr' }),
    ));
    expect(provider.resolveUrl).toHaveBeenCalledWith(
      'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42',
      expect.any(AbortSignal),
      { interactive: false },
    );
  });

  it('rehydrates only active imported work items', async () => {
    const provider = {
      ...createMockProvider('ado-pr-reviews'),
      resolveUrl: vi.fn(async () => ({
        title: '#42: Imported PR',
        notes: 'Imported notes',
        url: 'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42',
        externalId: 'myorg/MyProject/myrepo/42',
        providerId: 'ado-pr-reviews',
        itemType: 'pr' as const,
        capabilities: { gitWork: { kind: 'pr' as const, cloneUrl: 'https://myorg@dev.azure.com/myorg/MyProject/_git/myrepo', ref: 'users/me/fix' } },
      })),
    };
    const reg = new ProviderRegistry(
      stateStore,
      undefined,
      (_providerId, externalId) => externalId === 'myorg/MyProject/myrepo/42' ? WorkItemState.Archived : WorkItemState.InProgress,
      undefined,
      () => [
        {
          providerId: 'ado-pr-reviews',
          externalId: 'myorg/MyProject/myrepo/42',
          url: 'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42',
        },
        {
          providerId: 'ado-pr-reviews',
          externalId: 'myorg/MyProject/myrepo/43',
          url: 'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/43',
        },
      ],
    );

    reg.register(provider);
    await vi.waitFor(() => expect(provider.resolveUrl).toHaveBeenCalledTimes(1));
    expect(provider.resolveUrl).toHaveBeenCalledWith(
      'https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/43',
      expect.any(AbortSignal),
      { interactive: false },
    );
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

  it('treats registration refreshes as non-interactive', () => {
    const provider = createMockProvider('registration-auth');
    registry.register(provider);

    expect(provider.refresh).toHaveBeenCalledWith(expect.anything(), { interactive: false });
  });

  it('applies window state to already registered providers that support it', () => {
    const provider = {
      ...createMockProvider('window-aware'),
      setWindowState: vi.fn(),
    };
    registry.register(provider);
    provider.setWindowState.mockClear();
    const windowState = createMockWindowState(false);

    registry.setWindowState(windowState);

    expect(provider.setWindowState).toHaveBeenCalledOnce();
    expect(provider.setWindowState).toHaveBeenCalledWith(windowState);
  });

  it('applies window state to newly registered providers after state is set', () => {
    const windowState = createMockWindowState(false);
    registry.setWindowState(windowState);
    const provider = {
      ...createMockProvider('late-window-aware'),
      setWindowState: vi.fn(),
    };

    registry.register(provider);

    expect(provider.setWindowState).toHaveBeenCalledOnce();
    expect(provider.setWindowState).toHaveBeenCalledWith(windowState);
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

  it('does not try to apply window state to providers that do not support it', () => {
    const provider = createMockProvider('not-window-aware');
    registry.setWindowState(createMockWindowState(false));

    expect(() => registry.register(provider)).not.toThrow();
  });

  it('logs and ignores errors from window-state-aware providers', () => {
    const provider = {
      ...createMockProvider('throws-window-state'),
      setWindowState: vi.fn(() => {
        throw new Error('window state failed');
      }),
    };
    const warnSpy = vi.spyOn(logger, 'warn');

    registry.register(provider);

    try {
      expect(() => registry.setWindowState(createMockWindowState(false))).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith('Provider throws-window-state rejected window state updates', expect.any(Error));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs and ignores async errors from window-state-aware providers', async () => {
    const provider = {
      ...createMockProvider('async-window-state'),
      setWindowState: vi.fn(async () => {
        throw new Error('async window state failed');
      }),
    };
    const warnSpy = vi.spyOn(logger, 'warn');

    registry.register(provider);

    try {
      expect(() => registry.setWindowState(createMockWindowState(false))).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(warnSpy).toHaveBeenCalledWith('Provider async-window-state rejected window state updates', expect.any(Error));
    } finally {
      warnSpy.mockRestore();
    }
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

    const items = registry.getProviderItems('gh');
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Bug fix');
    expect(items[0].externalId).toBe('issue-1');
    expect(items[1].title).toBe('Feature');
  });

  it('replaces discovered items on re-discovery', async () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    provider.fireItems([
      { externalId: 'issue-1', title: 'Original title', description: 'Original desc' },
    ]);

    expect(registry.getProviderItems('gh')).toHaveLength(1);

    provider.fireItems([
      { externalId: 'issue-1', title: 'Updated title', description: 'Updated desc' },
    ]);

    // Per-provider serialization: the second emission is queued behind the
    // first one's awaits, so we have to drain microtasks before the updated
    // items become visible.
    await vi.waitFor(() => expect(registry.getProviderItems('gh')[0]?.title).toBe('Updated title'));

    const items = registry.getProviderItems('gh');
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

  it('treats refreshAll as interactive', async () => {
    const provider = createMockProvider('refresh-all-auth');
    registry.register(provider);
    vi.mocked(provider.refresh).mockClear();

    await registry.refreshAll();

    expect(provider.refresh).toHaveBeenCalledWith(expect.anything(), { interactive: true });
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

  it('handles synchronous refresh throws gracefully in refreshAll', async () => {
    const p1 = createMockProvider('sync-throw');
    registry.register(p1);
    await new Promise(resolve => setTimeout(resolve, 0));
    vi.mocked(p1.refresh).mockClear();
    vi.mocked(p1.refresh).mockImplementationOnce(() => { throw new Error('sync boom'); });

    await expect(registry.refreshAll()).resolves.toBeUndefined();

    expect(registry.isProviderRefreshing('sync-throw')).toBe(false);
    expect(registry.getProviderHealth('sync-throw').lastError).toBe('sync boom');
  });

  it('cancels provider refresh tokens when refreshAll token is cancelled', async () => {
    const provider = createMockProvider('cancel');
    registry.register(provider);
    await new Promise(resolve => setTimeout(resolve, 0));
    vi.mocked(provider.refresh).mockClear();

    let providerToken: { isCancellationRequested: boolean } | undefined;
    vi.mocked(provider.refresh).mockImplementationOnce((token?: any) => {
      providerToken = token;
      return new Promise<void>(() => {});
    });
    const listener = vi.fn();
    registry.onDidChangeProviderRefreshState(listener);
    const cts = new CancellationTokenSource();

    const refreshPromise = registry.refreshAll(cts.token);
    await vi.waitFor(() => expect(registry.isProviderRefreshing('cancel')).toBe(true));
    expect(providerToken?.isCancellationRequested).toBe(false);

    cts.cancel();
    await refreshPromise;

    expect(providerToken?.isCancellationRequested).toBe(true);
    expect(registry.isProviderRefreshing('cancel')).toBe(false);
    expect(registry.getProviderHealth('cancel').status).not.toBe('unhealthy');
    expect(listener).toHaveBeenCalledWith('cancel');
    cts.dispose();
  });

  it('reports refreshAll progress as each provider completes', async () => {
    const p1 = createMockProvider('p1');
    const p2 = createMockProvider('p2');
    registry.register(p1);
    registry.register(p2);
    await new Promise(resolve => setTimeout(resolve, 0));
    vi.mocked(p1.refresh).mockClear();
    vi.mocked(p2.refresh).mockClear();

    let resolveP1!: () => void;
    let resolveP2!: () => void;
    vi.mocked(p1.refresh).mockImplementationOnce(() => new Promise<void>(resolve => { resolveP1 = resolve; }));
    vi.mocked(p2.refresh).mockImplementationOnce(() => new Promise<void>(resolve => { resolveP2 = resolve; }));
    const onProgress = vi.fn();

    const refreshPromise = registry.refreshAll(undefined, onProgress);
    await vi.waitFor(() => expect(p2.refresh).toHaveBeenCalledTimes(1));

    resolveP2();
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith({
      providerId: 'p2',
      providerLabel: 'Provider p2',
      completed: 1,
      total: 2,
      pendingProviders: [{ id: 'p1', label: 'Provider p1' }],
      outcome: 'success',
    }));

    resolveP1();
    await refreshPromise;
    expect(onProgress).toHaveBeenCalledWith({
      providerId: 'p1',
      providerLabel: 'Provider p1',
      completed: 2,
      total: 2,
      pendingProviders: [],
      outcome: 'success',
    });
  });

  it('does not reject refreshAll when progress reporting throws', async () => {
    const provider = createMockProvider('progress-throws');
    registry.register(provider);
    await new Promise(resolve => setTimeout(resolve, 0));
    vi.mocked(provider.refresh).mockClear();
    const onProgress = vi.fn(() => { throw new Error('progress broke'); });

    await expect(registry.refreshAll(undefined, onProgress)).resolves.toBeUndefined();

    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(registry.getProviderHealth('progress-throws').status).toBe('healthy');
  });

  it('returns cancelled when refreshing an unregistered provider by id', async () => {
    await expect(registry.refreshProvider('missing')).resolves.toBe('cancelled');
  });

  it('treats single-provider refreshes as interactive', async () => {
    const provider = createMockProvider('single-refresh-auth');
    registry.register(provider);
    vi.mocked(provider.refresh).mockClear();

    await registry.refreshProvider('single-refresh-auth');

    expect(provider.refresh).toHaveBeenCalledWith(expect.anything(), { interactive: true });
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

  it('returns empty array from getProviderItems for unknown provider', () => {
    expect(registry.getProviderItems('nonexistent')).toEqual([]);
  });

  it('returns full map from getAllProviderItems with multiple providers', () => {
    const p1 = createMockProvider('gh');
    const p2 = createMockProvider('jira');
    registry.register(p1);
    registry.register(p2);

    p1.fireItems([{ externalId: '1', title: 'GH item' }]);
    p2.fireItems([{ externalId: '2', title: 'Jira item' }]);

    const all = registry.getAllProviderItems();
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

    // Wait for handleProviderItems to complete by checking items are stored
    await vi.waitFor(() =>
      expect(registry.getProviderItems('gh')).toHaveLength(1),
    );
    expect(stateStore.setStates).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('fires onDidChangeProviderItems when provider discovers items', async () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    const listener = vi.fn();
    registry.onDidChangeProviderItems(listener);

    provider.fireItems([{ externalId: '1', title: 'Item' }]);
    // handleProviderItems is async, wait for it to settle
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

    // Wait for handleProviderItems to complete
    await vi.waitFor(() =>
      expect(registry.getProviderItems('gh')).toHaveLength(1),
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
      const emitter = new EventEmitter<ProviderItem[]>();
      const provider: DevDocketProvider & { fireItems: (items: ProviderItem[]) => void } = {
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
        registry.onDidChangeProviderItems(() => {
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

    it('onDidChangeProviderItems fires when loading state transitions to false', async () => {
      const { provider, resolveRefresh } = createDeferredProvider('notif');

      const events: boolean[] = [];
      registry.onDidChangeProviderItems(() => {
        events.push(registry.loading);
      });

      registry.register(provider);
      // Register fires onDidChangeProviderItems with loading=true
      expect(events).toContain(true);

      resolveRefresh();
      await nextTick();
      // The .finally() fires onDidChangeProviderItems with loading=false
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
        const items = registry.getProviderItems('rapid');
        expect(items).toHaveLength(1);
        expect(items[0].externalId).toBe('3');
      });
    });

    it('fires onDidChangeProviderItems for each rapid update', async () => {
      const provider = createMockProvider('rapid');
      registry.register(provider);

      // Wait for registration/refresh to fully complete
      await vi.waitFor(() => expect(registry.loading).toBe(false));

      const listener = vi.fn();
      registry.onDidChangeProviderItems(listener);

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
        expect(registry.getProviderItems('alpha')).toHaveLength(1);
        expect(registry.getProviderItems('alpha')[0].externalId).toBe('a2');
        expect(registry.getProviderItems('beta')).toHaveLength(1);
        expect(registry.getProviderItems('beta')[0].externalId).toBe('b1');
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

      // Each fire triggers handleProviderItems, so unseenListener fires per batch
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
      registry.onDidChangeProviderItems(changeListener);

      provider.fireItems([]);

      await vi.waitFor(() => expect(changeListener).toHaveBeenCalled());
      expect(registry.getProviderItems('empty')).toEqual([]);
      // No unseen items to set
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('deregistration clears discovered items', () => {
      const provider = createMockProvider('clearme');
      const disposable = registry.register(provider);

      provider.fireItems([{ externalId: '1', title: 'Item' }]);
      expect(registry.getProviderItems('clearme')).toHaveLength(1);

      disposable.dispose();
      expect(registry.getProviderItems('clearme')).toEqual([]);
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

    it('fires onDidChangeProviderItems on deregistration', async () => {
      const provider = createMockProvider('notify');
      const disposable = registry.register(provider);

      // Wait for initial refresh to complete
      await vi.waitFor(() => expect(registry.loading).toBe(false));

      const listener = vi.fn();
      registry.onDidChangeProviderItems(listener);

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
        { interactive: false },
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
    function makeItems(count: number): ProviderItem[] {
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
        const stored = registry.getProviderItems('exact-cap');
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
        const stored = registry.getProviderItems('over-cap');
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
        expect(registry.getProviderItems('zero-items')).toEqual([]);
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
        const stored = registry.getProviderItems('order-check');
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
        const stored = registry.getProviderItems('truncated-only');
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
        expect(registry.getProviderItems('under-cap')).toHaveLength(
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
        expect(registry.getProviderItems('defensive-copy')).toHaveLength(3);
      });

      // Mutate the original array after it was stored
      items.push({ externalId: 'sneaky', title: 'Sneaky' });

      // The registry should still have only 3 items
      expect(registry.getProviderItems('defensive-copy')).toHaveLength(3);
    });
  });

  describe('version-based resurfacing', () => {
    it('stores version for newly discovered items', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-abc' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-abc' },
      ]);
    });

    it('resurfaces accepted item when version changes', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      // Simulate item previously accepted with version stored
      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-old');

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-new' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-new' },
      ]);
    });

    it('fires onDidAddNewUnseenItems when item is resurfaced', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-old');

      const listener = vi.fn();
      registry.onDidAddNewUnseenItems(listener);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-new' },
      ]);

      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(1));
    });

    it('does not resurface accepted item when version is unchanged', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-same');

      stateStore.setStates.mockClear();

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-same' },
      ]);

      await vi.waitFor(() =>
        expect(registry.getProviderItems('gh')).toHaveLength(1),
      );
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('backfills version for accepted item without stored version', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      // Previously accepted but no version stored (pre-existing item)
      stateStore._set('gh', 'pr-1', 'accepted');

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-first' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      // Should backfill version without changing state
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'accepted', version: 'sha-first' },
      ]);
    });

    it('does not fire onDidAddNewUnseenItems for backfill-only updates', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');

      const listener = vi.fn();
      registry.onDidAddNewUnseenItems(listener);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-first' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not resurface dismissed item even when version changes', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      stateStore._set('gh', 'pr-1', 'dismissed');
      stateStore._setVersion('gh', 'pr-1', 'sha-old');

      stateStore.setStates.mockClear();

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-new' },
      ]);

      await vi.waitFor(() =>
        expect(registry.getProviderItems('gh')).toHaveLength(1),
      );
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('does not resurface accepted item without version in discovery', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-old');

      stateStore.setStates.mockClear();

      // Item discovered without version (provider doesn't support versioning)
      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1' },
      ]);

      await vi.waitFor(() =>
        expect(registry.getProviderItems('gh')).toHaveLength(1),
      );
      expect(stateStore.setStates).not.toHaveBeenCalled();
    });

    it('keeps unseen item version in sync so acceptance snapshots latest version', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      // Item is unseen with an old version stored
      stateStore._set('gh', 'pr-1', 'unseen');
      stateStore._setVersion('gh', 'pr-1', 'sha-old');

      stateStore.setStates.mockClear();

      // Provider re-fires with updated version
      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-new' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      // Should update version while keeping state as unseen (backfill, not resurface)
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-new' },
      ]);
    });

    it('backfills version for unseen item without stored version', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      stateStore._set('gh', 'pr-1', 'unseen');

      stateStore.setStates.mockClear();

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-first' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-first' },
      ]);
    });
  });

  describe('resurfaceVersion-based resurfacing', () => {
    it('stores resurfaceVersion for newly discovered items', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-abc', resurfaceVersion: 'rr-ts1' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-abc', resurfaceVersion: 'rr-ts1' },
      ]);
    });

    it('resurfaces accepted item when resurfaceVersion changes', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-same');
      stateStore._setResurfaceVersion('gh', 'pr-1', 'rr-old');

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-same', resurfaceVersion: 'rr-new' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-same', resurfaceVersion: 'rr-new' },
      ]);
    });

    it('fires onDidAddNewUnseenItems when resurfaceVersion triggers resurfacing', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-same');
      stateStore._setResurfaceVersion('gh', 'pr-1', 'rr-old');

      const listener = vi.fn();
      registry.onDidAddNewUnseenItems(listener);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-same', resurfaceVersion: 'rr-new' },
      ]);

      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(1));
    });

    it.each([
      { inboxState: 'accepted' as const, commentKind: 'mention' as const, resurfaceVersion: 'rr-new', shouldResurface: true },
      { inboxState: 'accepted' as const, commentKind: 'non-mention' as const, resurfaceVersion: 'rr-old', shouldResurface: false },
      { inboxState: 'dismissed' as const, commentKind: 'mention' as const, resurfaceVersion: 'rr-new', shouldResurface: true },
      { inboxState: 'dismissed' as const, commentKind: 'non-mention' as const, resurfaceVersion: 'rr-old', shouldResurface: false },
    ])(
      '$inboxState item handles $commentKind comment resurfacing',
      async ({ inboxState, resurfaceVersion, shouldResurface }) => {
        const provider = createMockProvider('gh');
        registry.register(provider);

        stateStore._set('gh', 'pr-1', inboxState);
        stateStore._setVersion('gh', 'pr-1', 'sha-same');
        stateStore._setResurfaceVersion('gh', 'pr-1', 'rr-old');

        stateStore.setStates.mockClear();

        provider.fireItems([
          { externalId: 'pr-1', title: 'PR 1', version: 'sha-same', resurfaceVersion },
        ]);

        if (shouldResurface) {
          await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
          expect(stateStore.setStates).toHaveBeenCalledWith([
            { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-same', resurfaceVersion },
          ]);
        } else {
          await vi.waitFor(() =>
            expect(registry.getProviderItems('gh')).toHaveLength(1),
          );
          expect(stateStore.setStates).not.toHaveBeenCalled();
        }
      },
    );

    it('backfills resurfaceVersion for accepted item without stored resurfaceVersion', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-same');

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-same', resurfaceVersion: 'rr-first' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'accepted', version: 'sha-same', resurfaceVersion: 'rr-first' },
      ]);
    });

    it('backfills resurfaceVersion for dismissed item without stored resurfaceVersion', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      stateStore._set('gh', 'pr-1', 'dismissed');

      stateStore.setStates.mockClear();

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', resurfaceVersion: 'rr-first' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'dismissed', resurfaceVersion: 'rr-first' },
      ]);
    });

    it('resurfaces when version is unchanged but resurfaceVersion changes', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-same');
      stateStore._setResurfaceVersion('gh', 'pr-1', 'rr-old');

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-same', resurfaceVersion: 'rr-new' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      const call = stateStore.setStates.mock.calls[0][0];
      expect(call).toEqual([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-same', resurfaceVersion: 'rr-new' },
      ]);
    });

    it('keeps unseen item resurfaceVersion in sync', async () => {
      const provider = createMockProvider('gh');
      registry.register(provider);

      stateStore._set('gh', 'pr-1', 'unseen');
      stateStore._setResurfaceVersion('gh', 'pr-1', 'rr-old');

      stateStore.setStates.mockClear();

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', resurfaceVersion: 'rr-new' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', resurfaceVersion: 'rr-new' },
      ]);
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
      const emitter = new EventEmitter<ProviderItem[]>();
      const provider: DevDocketProvider & { fireItems: (items: ProviderItem[]) => void } = {
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
        const emitter = new EventEmitter<ProviderItem[]>();
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
      vi.useFakeTimers();
      try {
        const provider = createMockProvider('stable');
        registry.register(provider);
        // First refresh resolves immediately → healthy
        await vi.advanceTimersByTimeAsync(0);

        const listener = vi.fn();
        registry.onDidChangeProviderHealth(listener);

        // Advance faked clock to guarantee a different timestamp
        vi.setSystemTime(Date.now() + 1000);
        await registry.refreshAll();

        expect(listener).toHaveBeenCalledWith('stable');
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears health status when provider is unregistered', async () => {
      const provider = createMockProvider('temp');
      const disposable = registry.register(provider);
      await nextTick();

      expect(registry.getProviderHealth('temp').status).toBe('healthy');

      disposable.dispose();
      expect(registry.getProviderHealth('temp')).toEqual({ status: 'unknown' });
    });

    it('ignores queued provider item updates after the provider is unregistered', async () => {
      let releaseFirstUpdate!: () => void;
      const firstUpdate = new Promise<void>(resolve => { releaseFirstUpdate = resolve; });
      stateStore.setStates.mockImplementationOnce(() => firstUpdate);
      const { provider } = createDeferredProvider('stale-items');
      const disposable = registry.register(provider);

      provider.fireItems([{ externalId: 'first', title: 'First' }]);
      provider.fireItems([{ externalId: 'second', title: 'Second' }]);
      await vi.waitFor(() => expect(registry.getProviderHealth('stale-items').status).toBe('healthy'));

      disposable.dispose();
      releaseFirstUpdate();
      await nextTick();
      await nextTick();

      expect(registry.getProviderHealth('stale-items')).toEqual({ status: 'unknown' });
      expect(registry.getProviderItems('stale-items')).toEqual([]);
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

    it('recovers to healthy when a background refresh emits items after going unhealthy', async () => {
      // Providers extending BaseProvider drive periodic refresh via their own
      // setInterval, calling doBackgroundRefresh() directly. Those background
      // refreshes bypass refreshWithTimeout(), so receiving onDidDiscoverItems
      // is the only signal the registry has that a refresh succeeded.
      const provider = createMockProvider('recovers');
      vi.mocked(provider.refresh).mockRejectedValueOnce(new Error('initial fail'));
      registry.register(provider);
      await nextTick();

      expect(registry.getProviderHealth('recovers').status).toBe('unhealthy');

      const listener = vi.fn();
      registry.onDidChangeProviderHealth(listener);

      // Simulate a successful background refresh: provider emits items via
      // its own setInterval timer, without going through refreshWithTimeout.
      provider.fireItems([{ externalId: 'item-1', title: 'Recovered' }]);
      await nextTick();

      const health = registry.getProviderHealth('recovers');
      expect(health.status).toBe('healthy');
      expect(health.lastError).toBeUndefined();
      expect(health.lastRefreshTime).toBeInstanceOf(Date);
      expect(listener).toHaveBeenCalledWith('recovers');
    });
  });

  describe('resurfacing with work item state', () => {
    const activeWorkItemStates = [
      WorkItemState.New,
      WorkItemState.InProgress,
      WorkItemState.Paused,
    ];
    const completedOrMissingWorkItemStates = [
      WorkItemState.Done,
      WorkItemState.Archived,
      undefined,
    ];

    it.each(activeWorkItemStates)('suppresses accepted version resurfacing when work item is %s', async (workItemState) => {
      const getWorkItemState = vi.fn().mockReturnValue(workItemState);
      const addActivityFn = vi.fn().mockResolvedValue(undefined);
      const reg = new ProviderRegistry(stateStore, undefined, getWorkItemState, addActivityFn);
      const provider = createMockProvider('gh');
      reg.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-old');

      const listener = vi.fn();
      reg.onDidAddNewUnseenItems(listener);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-new' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'accepted', version: 'sha-new' },
      ]);
      expect(stateStore.getVersion('gh', 'pr-1')).toBe('sha-new');
      expect(listener).not.toHaveBeenCalled();
      expect(addActivityFn).not.toHaveBeenCalled();
      expect(getWorkItemState).toHaveBeenCalledWith('gh', 'pr-1');

      reg.dispose();
    });

    it.each(completedOrMissingWorkItemStates)('resurfaces accepted item on version change when work item is %s', async (workItemState) => {
      const getWorkItemState = vi.fn().mockReturnValue(workItemState);
      const reg = new ProviderRegistry(stateStore, undefined, getWorkItemState);
      const provider = createMockProvider('gh');
      reg.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-old');

      const listener = vi.fn();
      reg.onDidAddNewUnseenItems(listener);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-new' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-new' },
      ]);
      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(1));
      expect(getWorkItemState).toHaveBeenCalledWith('gh', 'pr-1');

      reg.dispose();
    });

    it.each(activeWorkItemStates)('suppresses accepted resurfaceVersion resurfacing when work item is %s', async (workItemState) => {
      const getWorkItemState = vi.fn().mockReturnValue(workItemState);
      const addActivityFn = vi.fn().mockResolvedValue(undefined);
      const reg = new ProviderRegistry(stateStore, undefined, getWorkItemState, addActivityFn);
      const provider = createMockProvider('gh');
      reg.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-same');
      stateStore._setResurfaceVersion('gh', 'pr-1', 'rr-old');

      const listener = vi.fn();
      reg.onDidAddNewUnseenItems(listener);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-same', resurfaceVersion: 'rr-new' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'accepted', version: 'sha-same', resurfaceVersion: 'rr-new' },
      ]);
      expect(stateStore.getResurfaceVersion('gh', 'pr-1')).toBe('rr-new');
      expect(listener).not.toHaveBeenCalled();
      expect(addActivityFn).not.toHaveBeenCalled();
      expect(getWorkItemState).toHaveBeenCalledWith('gh', 'pr-1');

      reg.dispose();
    });

    it.each(completedOrMissingWorkItemStates)('resurfaces accepted item on resurfaceVersion change when work item is %s', async (workItemState) => {
      const getWorkItemState = vi.fn().mockReturnValue(workItemState);
      const reg = new ProviderRegistry(stateStore, undefined, getWorkItemState);
      const provider = createMockProvider('gh');
      reg.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-same');
      stateStore._setResurfaceVersion('gh', 'pr-1', 'rr-old');

      const listener = vi.fn();
      reg.onDidAddNewUnseenItems(listener);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-same', resurfaceVersion: 'rr-new' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-same', resurfaceVersion: 'rr-new' },
      ]);
      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(1));
      expect(getWorkItemState).toHaveBeenCalledWith('gh', 'pr-1');

      reg.dispose();
    });

    it.each(activeWorkItemStates)('suppresses dismissed resurfaceVersion resurfacing when work item is %s', async (workItemState) => {
      const getWorkItemState = vi.fn().mockReturnValue(workItemState);
      const addActivityFn = vi.fn().mockResolvedValue(undefined);
      const reg = new ProviderRegistry(stateStore, undefined, getWorkItemState, addActivityFn);
      const provider = createMockProvider('gh');
      reg.register(provider);

      stateStore._set('gh', 'pr-1', 'dismissed');
      stateStore._setVersion('gh', 'pr-1', 'sha-same');
      stateStore._setResurfaceVersion('gh', 'pr-1', 'rr-old');

      const listener = vi.fn();
      reg.onDidAddNewUnseenItems(listener);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-same', resurfaceVersion: 'rr-new' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'dismissed', resurfaceVersion: 'rr-new' },
      ]);
      expect(stateStore.getResurfaceVersion('gh', 'pr-1')).toBe('rr-new');
      expect(listener).not.toHaveBeenCalled();
      expect(addActivityFn).not.toHaveBeenCalled();
      expect(getWorkItemState).toHaveBeenCalledWith('gh', 'pr-1');

      reg.dispose();
    });

    it.each(completedOrMissingWorkItemStates)('resurfaces dismissed item on resurfaceVersion change when work item is %s', async (workItemState) => {
      const getWorkItemState = vi.fn().mockReturnValue(workItemState);
      const reg = new ProviderRegistry(stateStore, undefined, getWorkItemState);
      const provider = createMockProvider('gh');
      reg.register(provider);

      stateStore._set('gh', 'pr-1', 'dismissed');
      stateStore._setVersion('gh', 'pr-1', 'sha-same');
      stateStore._setResurfaceVersion('gh', 'pr-1', 'rr-old');

      const listener = vi.fn();
      reg.onDidAddNewUnseenItems(listener);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-same', resurfaceVersion: 'rr-new' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-same', resurfaceVersion: 'rr-new' },
      ]);
      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(1));
      expect(getWorkItemState).toHaveBeenCalledWith('gh', 'pr-1');

      reg.dispose();
    });

    it('still resurfaces accepted version changes without getWorkItemState callback', async () => {
      const reg = new ProviderRegistry(stateStore);
      const provider = createMockProvider('gh');
      reg.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');
      stateStore._setVersion('gh', 'pr-1', 'sha-old');

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1', version: 'sha-new' },
      ]);

      await vi.waitFor(() => expect(stateStore.setStates).toHaveBeenCalled());
      expect(stateStore.setStates).toHaveBeenCalledWith([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-new' },
      ]);

      reg.dispose();
    });
  });
  describe('accepted items without version fields', () => {
    it('does not resurface accepted item re-emitted with no version or resurfaceVersion', async () => {
      const getWorkItemState = vi.fn().mockReturnValue(WorkItemState.Done);
      const reg = new ProviderRegistry(stateStore, undefined, getWorkItemState);
      const provider = createMockProvider('gh');
      reg.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');

      const listener = vi.fn();
      reg.onDidAddNewUnseenItems(listener);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1' },
      ]);

      // Allow handleProviderItems to process
      await vi.waitFor(() => expect(reg.getProviderItems('gh')).toHaveLength(1));
      // No state updates should have been made
      expect(stateStore.setStates).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();

      reg.dispose();
    });

    it('does not resurface accepted Done item re-emitted with no version after being in History', async () => {
      const getWorkItemState = vi.fn().mockReturnValue(WorkItemState.Done);
      const reg = new ProviderRegistry(stateStore, undefined, getWorkItemState);
      const provider = createMockProvider('gh');
      reg.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');

      const listener = vi.fn();
      reg.onDidAddNewUnseenItems(listener);

      // Re-emit same item multiple times (simulating repeated refreshes with no version)
      provider.fireItems([{ externalId: 'pr-1', title: 'PR 1' }]);
      await vi.waitFor(() => expect(reg.getProviderItems('gh')).toHaveLength(1));

      provider.fireItems([{ externalId: 'pr-1', title: 'PR 1' }]);
      await vi.waitFor(() => expect(reg.getProviderItems('gh')).toHaveLength(1));

      expect(stateStore.setStates).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();

      reg.dispose();
    });

    it('does not resurface accepted Archived item re-emitted with no version', async () => {
      const getWorkItemState = vi.fn().mockReturnValue(WorkItemState.Archived);
      const reg = new ProviderRegistry(stateStore, undefined, getWorkItemState);
      const provider = createMockProvider('gh');
      reg.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');

      const listener = vi.fn();
      reg.onDidAddNewUnseenItems(listener);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1' },
      ]);

      await vi.waitFor(() => expect(reg.getProviderItems('gh')).toHaveLength(1));
      expect(stateStore.setStates).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();

      reg.dispose();
    });

    it('does not resurface accepted item with no work item when no version set', async () => {
      // Work item was deleted (e.g., clearOldHistory) — getWorkItemState returns undefined
      const getWorkItemState = vi.fn().mockReturnValue(undefined);
      const reg = new ProviderRegistry(stateStore, undefined, getWorkItemState);
      const provider = createMockProvider('gh');
      reg.register(provider);

      stateStore._set('gh', 'pr-1', 'accepted');

      const listener = vi.fn();
      reg.onDidAddNewUnseenItems(listener);

      provider.fireItems([
        { externalId: 'pr-1', title: 'PR 1' },
      ]);

      await vi.waitFor(() => expect(reg.getProviderItems('gh')).toHaveLength(1));
      expect(stateStore.setStates).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();

      reg.dispose();
    });

    it('serializes back-to-back onDidDiscoverItems emissions per provider', async () => {
      // Regression test: two rapid emissions used to interleave their async
      // bodies, mixing up the previous-snapshot bookkeeping. Since we now
      // queue per-provider, the second emission's handleProviderItems
      // can't start until the first one's awaits have all settled, so the
      // final state must reflect ONLY the second emission's items.
      const pendingResolvers: Array<() => void> = [];
      stateStore.setStates = vi.fn(() => new Promise<void>(resolve => {
        pendingResolvers.push(resolve);
      }));

      const provider = createMockProvider('gh');
      registry.register(provider);

      // First emission: synchronous prefix runs immediately.
      provider.fireItems([{ externalId: 'a', title: 'A' }]);
      expect(registry.getProviderItems('gh').map(i => i.externalId)).toEqual(['a']);
      expect(pendingResolvers).toHaveLength(1);

      // Second emission while the first's setStates is still in-flight.
      provider.fireItems([{ externalId: 'b', title: 'B' }]);
      // Synchronous portion of the second emission must NOT have run yet —
      // it's queued behind the unresolved first invocation, so the second
      // setStates hasn't been called yet either.
      expect(registry.getProviderItems('gh').map(i => i.externalId)).toEqual(['a']);
      expect(pendingResolvers).toHaveLength(1);

      // Resolve the first's setStates so the queue can drain.
      pendingResolvers[0]();
      await vi.waitFor(() => expect(registry.getProviderItems('gh').map(i => i.externalId)).toEqual(['b']));

      // Drain the second one's setStates so the test doesn't leak a pending promise.
      await vi.waitFor(() => expect(pendingResolvers).toHaveLength(2));
      pendingResolvers[1]();
    });
  });

  describe('resolveUrl', () => {
    function nextTick(): Promise<void> {
      return new Promise(resolve => setTimeout(resolve, 0));
    }

    it('returns undefined when no providers support resolveUrl', async () => {
      const provider = createMockProvider('basic');
      registry.register(provider);
      await nextTick();

      const result = await registry.resolveUrl('https://example.com/item/1');
      expect(result).toBeUndefined();
    });

    it('returns result from the first provider that resolves', async () => {
      const p1 = createMockProvider('a');
      (p1 as any).resolveUrl = vi.fn(async () => undefined);
      const p2 = createMockProvider('b');
      (p2 as any).resolveUrl = vi.fn(async () => ({
        title: 'Issue 1',
        notes: 'body',
        url: 'https://example.com/1',
        externalId: '1',
        providerId: 'ignored',
      }));
      registry.register(p1);
      registry.register(p2);
      await nextTick();

      const result = await registry.resolveUrl('https://example.com/1');
      expect(result).toEqual({
        title: 'Issue 1',
        notes: 'body',
        url: 'https://example.com/1',
        externalId: '1',
        providerId: 'b',
      });
      expect((p1 as any).resolveUrl).toHaveBeenCalled();
    });

    it('overrides providerId with the provider id', async () => {
      const p1 = createMockProvider('real-id');
      (p1 as any).resolveUrl = vi.fn(async () => ({
        title: 'T',
        notes: 'N',
        url: 'https://u',
        externalId: 'e',
        providerId: 'wrong-id',
      }));
      registry.register(p1);
      await nextTick();

      const result = await registry.resolveUrl('https://u');
      expect(result?.providerId).toBe('real-id');
    });

    it('re-throws AbortError without trying remaining providers', async () => {
      const p1 = createMockProvider('a');
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      (p1 as any).resolveUrl = vi.fn(async () => { throw abortError; });
      const p2 = createMockProvider('b');
      (p2 as any).resolveUrl = vi.fn(async () => ({
        title: 'T', notes: 'N', url: 'https://u', externalId: 'e', providerId: 'b',
      }));
      registry.register(p1);
      registry.register(p2);
      await nextTick();

      await expect(registry.resolveUrl('https://u')).rejects.toThrow('Aborted');
      expect((p2 as any).resolveUrl).not.toHaveBeenCalled();
    });

    it('re-throws non-abort errors from a provider', async () => {
      const p1 = createMockProvider('a');
      (p1 as any).resolveUrl = vi.fn(async () => { throw new Error('API error'); });
      registry.register(p1);
      await nextTick();

      await expect(registry.resolveUrl('https://u')).rejects.toThrow('API error');
    });

    it('skips providers without resolveUrl and continues', async () => {
      const p1 = createMockProvider('no-resolve');
      const p2 = createMockProvider('has-resolve');
      (p2 as any).resolveUrl = vi.fn(async () => ({
        title: 'T', notes: 'N', url: 'https://u', externalId: 'e', providerId: 'has-resolve',
      }));
      registry.register(p1);
      registry.register(p2);
      await nextTick();

      const result = await registry.resolveUrl('https://u');
      expect(result).toBeDefined();
      expect(result?.providerId).toBe('has-resolve');
    });

    it('passes signal to the provider', async () => {
      const p1 = createMockProvider('sig');
      (p1 as any).resolveUrl = vi.fn(async () => undefined);
      registry.register(p1);
      await nextTick();

      const signal = AbortSignal.abort();
      await registry.resolveUrl('https://u', signal);
      expect((p1 as any).resolveUrl).toHaveBeenCalledWith('https://u', signal, undefined);
    });

    it('passes resolveUrl options to the provider', async () => {
      const p1 = createMockProvider('opts');
      (p1 as any).resolveUrl = vi.fn(async () => undefined);
      registry.register(p1);
      await nextTick();

      await registry.resolveUrl('https://u', undefined, { interactive: false });
      expect((p1 as any).resolveUrl).toHaveBeenCalledWith('https://u', undefined, { interactive: false });
    });
  });
});
