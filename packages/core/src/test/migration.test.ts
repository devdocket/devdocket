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
