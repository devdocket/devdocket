import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkItem, WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';
import { WorkGraph } from '../services/workGraph';

/**
 * Tests the migration logic from extension.ts:
 * Existing WorkItems with providerId+externalId get 'accepted' state.
 */

function createMockStore(items: WorkItem[]): ITaskStore {
  const map = new Map(items.map((i) => [i.id, i]));
  return {
    loadAll: vi.fn(async () => Array.from(map.values())),
    save: vi.fn(async (item) => { map.set(item.id, item); }),
    saveAll: vi.fn(async (batch) => { for (const item of batch) { map.set(item.id, item); } }),
    delete: vi.fn(async (id) => { map.delete(id); }),
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
    load: vi.fn(async () => {}),
    loadAll: vi.fn(async () => []),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  };
}

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wc-test-1',
    title: 'Test item',
    state: WorkItemState.New,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Replicate the migration logic from extension.ts for isolated testing.
 */
async function runMigration(
  workGraph: WorkGraph,
  stateStore: ReturnType<typeof createMockStateStore>,
): Promise<void> {
  for (const item of workGraph.getAll()) {
    if (item.providerId && item.externalId) {
      const existing = stateStore.getState(item.providerId, item.externalId);
      if (existing === undefined) {
        await stateStore.setState(item.providerId, item.externalId, 'accepted');
      }
    }
  }
}

describe('Migration: existing WorkItems → accepted state', () => {
  let stateStore: ReturnType<typeof createMockStateStore>;

  beforeEach(() => {
    stateStore = createMockStateStore();
  });

  it('should mark existing provider-backed WorkItems as accepted', async () => {
    const items = [
      makeWorkItem({ id: 'a', providerId: 'gh', externalId: 'issue-1' }),
      makeWorkItem({ id: 'b', providerId: 'gh', externalId: 'issue-2' }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    await runMigration(graph, stateStore);

    expect(stateStore.setState).toHaveBeenCalledWith('gh', 'issue-1', 'accepted');
    expect(stateStore.setState).toHaveBeenCalledWith('gh', 'issue-2', 'accepted');
    expect(stateStore.setState).toHaveBeenCalledTimes(2);
  });

  it('should skip WorkItems without providerId', async () => {
    const items = [
      makeWorkItem({ id: 'a', title: 'Manual item' }),
      makeWorkItem({ id: 'b', providerId: 'gh', externalId: 'issue-1' }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    await runMigration(graph, stateStore);

    expect(stateStore.setState).toHaveBeenCalledTimes(1);
    expect(stateStore.setState).toHaveBeenCalledWith('gh', 'issue-1', 'accepted');
  });

  it('should skip WorkItems without externalId', async () => {
    const items = [
      makeWorkItem({ id: 'a', providerId: 'gh' }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    await runMigration(graph, stateStore);

    expect(stateStore.setState).not.toHaveBeenCalled();
  });

  it('should not overwrite already-migrated items', async () => {
    const items = [
      makeWorkItem({ id: 'a', providerId: 'gh', externalId: 'issue-1' }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    // Simulate already-migrated state
    stateStore.getState.mockReturnValue('accepted');

    await runMigration(graph, stateStore);

    expect(stateStore.setState).not.toHaveBeenCalled();
  });

  it('should not overwrite dismissed state during migration', async () => {
    const items = [
      makeWorkItem({ id: 'a', providerId: 'gh', externalId: 'issue-1' }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    stateStore.getState.mockReturnValue('dismissed');

    await runMigration(graph, stateStore);

    expect(stateStore.setState).not.toHaveBeenCalled();
  });

  it('should handle empty workGraph gracefully', async () => {
    const store = createMockStore([]);
    const graph = new WorkGraph(store);
    await graph.load();

    await runMigration(graph, stateStore);

    expect(stateStore.setState).not.toHaveBeenCalled();
  });

  it('should handle items from multiple providers', async () => {
    const items = [
      makeWorkItem({ id: 'a', providerId: 'gh', externalId: 'issue-1' }),
      makeWorkItem({ id: 'b', providerId: 'jira', externalId: 'PROJ-42' }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    await runMigration(graph, stateStore);

    expect(stateStore.setState).toHaveBeenCalledWith('gh', 'issue-1', 'accepted');
    expect(stateStore.setState).toHaveBeenCalledWith('jira', 'PROJ-42', 'accepted');
  });
});

/**
 * Adds setStates to the mock so we can test the batch migration path
 * that matches the actual extension.ts implementation.
 */
function createMockStateStoreWithBatch() {
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
  };
}

/**
 * Replicates the item-selection and batched `setStates` behavior from
 * extension.ts (lines 56-78): eligible items are collected into an array and
 * migrated with a single `setStates` call rather than individual `setState`
 * calls. This helper does not mirror the production logging behavior.
 */
async function runBatchMigration(
  workGraph: WorkGraph,
  stateStore: ReturnType<typeof createMockStateStoreWithBatch>,
): Promise<void> {
  const itemsToMigrate: Array<{ providerId: string; externalId: string; state: 'accepted' }> = [];

  for (const item of workGraph.getAll()) {
    if (item.providerId && item.externalId) {
      const existing = stateStore.getState(item.providerId, item.externalId);
      if (existing === undefined) {
        itemsToMigrate.push({
          providerId: item.providerId,
          externalId: item.externalId,
          state: 'accepted',
        });
      }
    }
  }

  if (itemsToMigrate.length > 0) {
    try {
      await stateStore.setStates(itemsToMigrate);
    } catch {
      // Intentionally swallow migration errors in this test helper; do not rethrow.
    }
  }
}

describe('Batch migration (matches extension.ts setStates path)', () => {
  let stateStore: ReturnType<typeof createMockStateStoreWithBatch>;

  beforeEach(() => {
    stateStore = createMockStateStoreWithBatch();
  });

  it('should call setStates once with all items to migrate', async () => {
    const items = [
      makeWorkItem({ id: 'a', providerId: 'gh', externalId: 'issue-1' }),
      makeWorkItem({ id: 'b', providerId: 'gh', externalId: 'issue-2' }),
      makeWorkItem({ id: 'c', providerId: 'jira', externalId: 'PROJ-10' }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    await runBatchMigration(graph, stateStore);

    expect(stateStore.setStates).toHaveBeenCalledTimes(1);
    expect(stateStore.setStates).toHaveBeenCalledWith([
      { providerId: 'gh', externalId: 'issue-1', state: 'accepted' },
      { providerId: 'gh', externalId: 'issue-2', state: 'accepted' },
      { providerId: 'jira', externalId: 'PROJ-10', state: 'accepted' },
    ]);
    // Individual setState should NOT be called in batch path
    expect(stateStore.setState).not.toHaveBeenCalled();
  });

  it('should not call setStates when no items need migration', async () => {
    const store = createMockStore([]);
    const graph = new WorkGraph(store);
    await graph.load();

    await runBatchMigration(graph, stateStore);

    expect(stateStore.setStates).not.toHaveBeenCalled();
  });

  it('should migrate items in Done, Archived, InProgress, and Blocked states', async () => {
    const items = [
      makeWorkItem({ id: 'done1', providerId: 'gh', externalId: 'e-done', state: WorkItemState.Done }),
      makeWorkItem({ id: 'arch1', providerId: 'gh', externalId: 'e-archived', state: WorkItemState.Archived }),
      makeWorkItem({ id: 'ip1', providerId: 'gh', externalId: 'e-inprogress', state: WorkItemState.InProgress }),
      makeWorkItem({ id: 'bl1', providerId: 'gh', externalId: 'e-blocked', state: WorkItemState.Blocked }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    await runBatchMigration(graph, stateStore);

    expect(stateStore.setStates).toHaveBeenCalledTimes(1);
    const batch = stateStore.setStates.mock.calls[0][0];
    expect(batch).toHaveLength(4);
    expect(batch).toEqual(
      expect.arrayContaining([
        { providerId: 'gh', externalId: 'e-done', state: 'accepted' },
        { providerId: 'gh', externalId: 'e-archived', state: 'accepted' },
        { providerId: 'gh', externalId: 'e-inprogress', state: 'accepted' },
        { providerId: 'gh', externalId: 'e-blocked', state: 'accepted' },
      ]),
    );
  });

  it('should skip items with empty string externalId', async () => {
    const items = [
      makeWorkItem({ id: 'a', providerId: 'gh', externalId: '' }),
      makeWorkItem({ id: 'b', providerId: 'gh', externalId: 'issue-1' }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    await runBatchMigration(graph, stateStore);

    expect(stateStore.setStates).toHaveBeenCalledTimes(1);
    expect(stateStore.setStates).toHaveBeenCalledWith([
      { providerId: 'gh', externalId: 'issue-1', state: 'accepted' },
    ]);
  });

  it('should skip items with empty string providerId', async () => {
    const items = [
      makeWorkItem({ id: 'a', providerId: '', externalId: 'issue-1' }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    await runBatchMigration(graph, stateStore);

    expect(stateStore.setStates).not.toHaveBeenCalled();
  });

  it('should not double-accept when provider discovers the same item concurrently', async () => {
    const items = [
      makeWorkItem({ id: 'a', providerId: 'gh', externalId: 'issue-1' }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    // Simulate a provider already discovering/accepting the item before migration runs
    stateStore.getState.mockReturnValue('unseen');

    await runBatchMigration(graph, stateStore);

    // Item already has a state ('unseen'), so migration should skip it
    expect(stateStore.setStates).not.toHaveBeenCalled();
  });

  it('should catch setStates failure without rethrowing', async () => {
    const items = [
      makeWorkItem({ id: 'a', providerId: 'gh', externalId: 'issue-1' }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    stateStore.setStates.mockRejectedValueOnce(new Error('disk full'));

    // Should not throw — the catch block in extension.ts swallows the error
    await expect(runBatchMigration(graph, stateStore)).resolves.toBeUndefined();
    expect(stateStore.setStates).toHaveBeenCalledTimes(1);
  });

  it('should handle large batch migration (100+ items)', async () => {
    const items: WorkItem[] = [];
    for (let i = 0; i < 150; i++) {
      items.push(
        makeWorkItem({
          id: `item-${i}`,
          providerId: `provider-${i % 3}`,
          externalId: `ext-${i}`,
        }),
      );
    }
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    await runBatchMigration(graph, stateStore);

    expect(stateStore.setStates).toHaveBeenCalledTimes(1);
    const batch = stateStore.setStates.mock.calls[0][0];
    expect(batch).toHaveLength(150);
    // Verify a sample from each provider
    expect(batch).toEqual(
      expect.arrayContaining([
        { providerId: 'provider-0', externalId: 'ext-0', state: 'accepted' },
        { providerId: 'provider-1', externalId: 'ext-1', state: 'accepted' },
        { providerId: 'provider-2', externalId: 'ext-2', state: 'accepted' },
        { providerId: 'provider-0', externalId: 'ext-147', state: 'accepted' },
      ]),
    );
  });

  it('should exclude already-migrated items from the batch', async () => {
    const items = [
      makeWorkItem({ id: 'a', providerId: 'gh', externalId: 'issue-1' }),
      makeWorkItem({ id: 'b', providerId: 'gh', externalId: 'issue-2' }),
      makeWorkItem({ id: 'c', providerId: 'gh', externalId: 'issue-3' }),
    ];
    const store = createMockStore(items);
    const graph = new WorkGraph(store);
    await graph.load();

    // issue-2 already has state
    stateStore.getState.mockImplementation((_providerId: string, externalId: string) => {
      if (externalId === 'issue-2') {
        return 'accepted' as any;
      }
      return undefined;
    });

    await runBatchMigration(graph, stateStore);

    expect(stateStore.setStates).toHaveBeenCalledTimes(1);
    const batch = stateStore.setStates.mock.calls[0][0];
    expect(batch).toHaveLength(2);
    expect(batch).toEqual(
      expect.arrayContaining([
        { providerId: 'gh', externalId: 'issue-1', state: 'accepted' },
        { providerId: 'gh', externalId: 'issue-3', state: 'accepted' },
      ]),
    );
    expect(batch).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: 'issue-2' }),
      ]),
    );
  });
});
