import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkAutoComplete } from '../services/autoComplete';
import { WorkGraph } from '../services/workGraph';
import { WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';
import { ProviderRegistry } from '../services/providerRegistry';

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    saveAll: vi.fn(async (batch) => { for (const item of batch) { items.set(item.id, item); } }),
    delete: vi.fn(async (id) => { items.delete(id); }),
  };
}

function createMockRegistry(overrides: {
  getProvider?: () => any;
  getDiscoveredItems?: () => any[];
  wasLastRefreshTruncated?: () => boolean;
  wasItemPreviouslyDiscovered?: () => boolean;
} = {}): ProviderRegistry {
  return {
    getProvider: overrides.getProvider ?? (() => undefined),
    getDiscoveredItems: overrides.getDiscoveredItems ?? (() => []),
    wasLastRefreshTruncated: overrides.wasLastRefreshTruncated ?? (() => false),
    wasItemPreviouslyDiscovered: overrides.wasItemPreviouslyDiscovered ?? (() => true),
  } as unknown as ProviderRegistry;
}

describe('checkAutoComplete', () => {
  const providerId = 'test-provider';
  let store: ITaskStore;
  let graph: WorkGraph;

  beforeEach(async () => {
    store = createMockStore();
    graph = new WorkGraph(store);
    await graph.load();
  });

  describe('activity log entries', () => {
    it('appends an auto-completed activity entry after transition', async () => {
      const item = await graph.createItem(
        { title: 'Issue A' },
        { providerId, externalId: 'ext-1' },
      );

      const registry = createMockRegistry({
        getProvider: () => ({
          getClosedItems: async () => ['ext-1'],
        }),
      });

      await checkAutoComplete(providerId, graph, registry);

      const updated = graph.getItem(item.id)!;
      expect(updated.state).toBe(WorkItemState.Done);

      const autoEntry = updated.activityLog!.find(e => e.type === 'auto-completed');
      expect(autoEntry).toBeDefined();
      expect(autoEntry!.detail).toBe('Provider detected external closure (New → Done)');
    });

    it('records pre-transition state in auto-completed detail for InProgress items', async () => {
      const item = await graph.createItem(
        { title: 'In-progress task' },
        { providerId, externalId: 'ext-2' },
      );
      await graph.transitionState(item.id, WorkItemState.InProgress);

      const registry = createMockRegistry({
        getProvider: () => ({
          getClosedItems: async () => ['ext-2'],
        }),
      });

      await checkAutoComplete(providerId, graph, registry);

      const updated = graph.getItem(item.id)!;
      const autoEntry = updated.activityLog!.find(e => e.type === 'auto-completed');
      expect(autoEntry).toBeDefined();
      expect(autoEntry!.detail).toBe('Provider detected external closure (InProgress → Done)');
    });

    it('records pre-transition state in auto-completed detail for Paused items', async () => {
      const item = await graph.createItem(
        { title: 'Paused task' },
        { providerId, externalId: 'ext-3' },
      );
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Paused);

      const registry = createMockRegistry({
        getProvider: () => ({
          getClosedItems: async () => ['ext-3'],
        }),
      });

      await checkAutoComplete(providerId, graph, registry);

      const updated = graph.getItem(item.id)!;
      const autoEntry = updated.activityLog!.find(e => e.type === 'auto-completed');
      expect(autoEntry).toBeDefined();
      expect(autoEntry!.detail).toBe('Provider detected external closure (Paused → Done)');
    });

    it('auto-completed entry appears after the state-changed entry', async () => {
      const item = await graph.createItem(
        { title: 'Order check' },
        { providerId, externalId: 'ext-4' },
      );

      const registry = createMockRegistry({
        getProvider: () => ({
          getClosedItems: async () => ['ext-4'],
        }),
      });

      await checkAutoComplete(providerId, graph, registry);

      const updated = graph.getItem(item.id)!;
      const log = updated.activityLog!;
      const stateIdx = log.findIndex(e => e.type === 'state-changed' && e.detail?.includes('Done'));
      const autoIdx = log.findIndex(e => e.type === 'auto-completed');
      expect(stateIdx).toBeGreaterThanOrEqual(0);
      expect(autoIdx).toBeGreaterThan(stateIdx);
    });

    it('does not propagate auto-complete through closes links', async () => {
      const issue = await graph.createItem(
        { title: 'Closed issue' },
        { providerId, externalId: 'ext-5' },
      );
      const pr = await graph.createItem(
        { title: 'Linked PR' },
        { providerId, externalId: 'ext-6' },
      );
      graph.setLinkLookup((itemId) => itemId === issue.id || itemId === pr.id
        ? [{ id: 'link-1', itemId1: issue.id, itemId2: pr.id, relation: 'closes', origin: 'provider' }]
        : []);

      const registry = createMockRegistry({
        getProvider: () => ({
          getClosedItems: async () => ['ext-5'],
        }),
      });

      await checkAutoComplete(providerId, graph, registry);

      expect(graph.getItem(issue.id)?.state).toBe(WorkItemState.Done);
      expect(graph.getItem(pr.id)?.state).toBe(WorkItemState.New);
    });

    it('returns completed titles', async () => {
      await graph.createItem(
        { title: 'Closed issue' },
        { providerId, externalId: 'ext-5' },
      );

      const registry = createMockRegistry({
        getProvider: () => ({
          getClosedItems: async () => ['ext-5'],
        }),
      });

      const titles = await checkAutoComplete(providerId, graph, registry);
      expect(titles).toEqual(['Closed issue']);
    });

    it('does not log auto-completed for items not in closedIds', async () => {
      const item = await graph.createItem(
        { title: 'Still open' },
        { providerId, externalId: 'ext-6' },
      );

      const registry = createMockRegistry({
        getProvider: () => ({
          getClosedItems: async () => [],
        }),
      });

      await checkAutoComplete(providerId, graph, registry);

      const updated = graph.getItem(item.id)!;
      expect(updated.state).toBe(WorkItemState.New);
      const autoEntry = updated.activityLog?.find(e => e.type === 'auto-completed');
      expect(autoEntry).toBeUndefined();
    });
  });
});
