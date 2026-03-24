import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'vscode';
import { WorkCenterProvider, DiscoveredItem } from '../api/types';
import { WorkGraph } from '../services/workGraph';
import { ProviderRegistry } from '../services/providerRegistry';
import { ITaskStore } from '../storage/taskStore';
import { WorkItemState } from '../models/workItem';

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    delete: vi.fn(async (id) => { items.delete(id); }),
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
  let registry: ProviderRegistry;

  beforeEach(async () => {
    store = createMockStore();
    graph = new WorkGraph(store);
    await graph.load();
    registry = new ProviderRegistry(graph);
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

  it('creates WorkItems in the WorkGraph when provider fires onDidDiscoverItems', async () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    provider.fireItems([
      { externalId: 'issue-1', title: 'Bug fix', description: 'Fix the bug', url: 'https://github.com/issue/1' },
      { externalId: 'issue-2', title: 'Feature', url: 'https://github.com/issue/2' },
    ]);

    // Allow async createItem calls to settle
    await vi.waitFor(() => {
      const items = graph.getAll();
      expect(items).toHaveLength(2);
    });

    const items = graph.getAll();
    expect(items[0].title).toBe('Bug fix');
    expect(items[0].providerId).toBe('gh');
    expect(items[0].externalId).toBe('issue-1');
    expect(items[1].title).toBe('Feature');
  });

  it('updates existing items instead of duplicating when same providerId+externalId fires again', async () => {
    const provider = createMockProvider('gh');
    registry.register(provider);

    // First discovery
    provider.fireItems([
      { externalId: 'issue-1', title: 'Original title', description: 'Original desc' },
    ]);

    await vi.waitFor(() => {
      expect(graph.getAll()).toHaveLength(1);
    });

    const originalId = graph.getAll()[0].id;

    // Second discovery with updated title
    provider.fireItems([
      { externalId: 'issue-1', title: 'Updated title', description: 'Updated desc' },
    ]);

    await vi.waitFor(() => {
      expect(graph.getAll()[0].title).toBe('Updated title');
    });

    const items = graph.getAll();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(originalId);
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
});
