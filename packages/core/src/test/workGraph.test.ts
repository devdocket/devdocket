import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkGraph } from '../services/workGraph';
import { WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    saveAll: vi.fn(async (batch) => { for (const item of batch) { items.set(item.id, item); } }),
    delete: vi.fn(async (id) => { items.delete(id); }),
  };
}

describe('WorkGraph', () => {
  let store: ITaskStore;
  let graph: WorkGraph;

  beforeEach(async () => {
    store = createMockStore();
    // WorkGraph uses vscode.EventEmitter — we need to mock it
    // Since we're running outside VS Code, mock the vscode module
    graph = new WorkGraph(store);
    await graph.load();
  });

  it('creates a work item in New state', async () => {
    const item = await graph.createItem({ title: 'Test' });

    expect(item.title).toBe('Test');
    expect(item.state).toBe(WorkItemState.New);
    expect(item.id).toMatch(/^wc-/);
    expect(store.save).toHaveBeenCalledWith(item);
  });

  it('creates items with unique ids', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });

    expect(a.id).not.toBe(b.id);
  });

  it('gets items by state', async () => {
    await graph.createItem({ title: 'A' });
    await graph.createItem({ title: 'B' });
    const item = await graph.createItem({ title: 'C' });
    await graph.transitionState(item.id, WorkItemState.InProgress);

    const newItems = graph.getItemsByState(WorkItemState.New);
    const activeItems = graph.getItemsByState(WorkItemState.InProgress);

    expect(newItems).toHaveLength(2);
    expect(activeItems).toHaveLength(1);
    expect(activeItems[0].title).toBe('C');
  });

  it('transitions state', async () => {
    const item = await graph.createItem({ title: 'Test' });
    await graph.transitionState(item.id, WorkItemState.InProgress);

    const updated = graph.getItem(item.id);
    expect(updated?.state).toBe(WorkItemState.InProgress);
  });

  it('transitions through full lifecycle', async () => {
    const item = await graph.createItem({ title: 'Lifecycle' });

    await graph.transitionState(item.id, WorkItemState.InProgress);
    expect(graph.getItem(item.id)?.state).toBe(WorkItemState.InProgress);

    await graph.transitionState(item.id, WorkItemState.Blocked);
    expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Blocked);

    await graph.transitionState(item.id, WorkItemState.InProgress);
    expect(graph.getItem(item.id)?.state).toBe(WorkItemState.InProgress);

    await graph.transitionState(item.id, WorkItemState.Done);
    expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Done);

    await graph.transitionState(item.id, WorkItemState.Archived);
    expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Archived);
  });

  it('throws when transitioning unknown item', async () => {
    await expect(graph.transitionState('nonexistent', WorkItemState.Done))
      .rejects.toThrow('Work item not found');
  });

  it('updates item fields', async () => {
    const item = await graph.createItem({ title: 'Original' });
    await graph.updateItem(item.id, { title: 'Updated' });

    const updated = graph.getItem(item.id);
    expect(updated?.title).toBe('Updated');
  });

  it('throws when updating unknown item', async () => {
    await expect(graph.updateItem('nonexistent', { title: 'X' }))
      .rejects.toThrow('Work item not found');
  });

  it('deletes an item', async () => {
    const item = await graph.createItem({ title: 'Delete me' });
    await graph.deleteItem(item.id);

    expect(graph.getItem(item.id)).toBeUndefined();
    expect(graph.getAll()).toHaveLength(0);
    expect(store.delete).toHaveBeenCalledWith(item.id);
  });

  it('fires change events on create', async () => {
    const listener = vi.fn();
    graph.onDidChange(listener);

    await graph.createItem({ title: 'Test' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires change events on state transition', async () => {
    const item = await graph.createItem({ title: 'Test' });
    const listener = vi.fn();
    graph.onDidChange(listener);

    await graph.transitionState(item.id, WorkItemState.InProgress);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('sets notes on create', async () => {
    const item = await graph.createItem({
      title: 'Detailed',
      notes: 'A detailed bug report',
    });

    expect(item.notes).toBe('A detailed bug report');
  });

  it('assigns sortOrder on creation', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });
    const c = await graph.createItem({ title: 'C' });

    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
    expect(c.sortOrder).toBe(2);
  });

  it('moves an item down', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });
    const c = await graph.createItem({ title: 'C' });

    await graph.moveItem(a.id, 'down');

    const items = graph.getItemsByState(WorkItemState.New)
      .sort((x, y) => (x.sortOrder ?? Number.MAX_SAFE_INTEGER) - (y.sortOrder ?? Number.MAX_SAFE_INTEGER));
    expect(items.map((i) => i.title)).toEqual(['B', 'A', 'C']);
  });

  it('moves an item up', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });
    const c = await graph.createItem({ title: 'C' });

    await graph.moveItem(c.id, 'up');

    const items = graph.getItemsByState(WorkItemState.New)
      .sort((x, y) => (x.sortOrder ?? Number.MAX_SAFE_INTEGER) - (y.sortOrder ?? Number.MAX_SAFE_INTEGER));
    expect(items.map((i) => i.title)).toEqual(['A', 'C', 'B']);
  });

  it('moving the first item up is a no-op', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });

    await graph.moveItem(a.id, 'up');

    const items = graph.getItemsByState(WorkItemState.New)
      .sort((x, y) => (x.sortOrder ?? Number.MAX_SAFE_INTEGER) - (y.sortOrder ?? Number.MAX_SAFE_INTEGER));
    expect(items.map((i) => i.title)).toEqual(['A', 'B']);
  });

  it('moving the last item down is a no-op', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });

    await graph.moveItem(b.id, 'down');

    const items = graph.getItemsByState(WorkItemState.New)
      .sort((x, y) => (x.sortOrder ?? Number.MAX_SAFE_INTEGER) - (y.sortOrder ?? Number.MAX_SAFE_INTEGER));
    expect(items.map((i) => i.title)).toEqual(['A', 'B']);
  });

  it('throws when moving unknown item', async () => {
    await expect(graph.moveItem('nonexistent', 'up'))
      .rejects.toThrow('Work item not found');
  });

  it('creates item after legacy items without sortOrder', async () => {
    const legacyStore = createMockStore();

    await legacyStore.save({
      id: 'legacy-a',
      title: 'A',
      state: WorkItemState.New,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    await legacyStore.save({
      id: 'legacy-b',
      title: 'B',
      state: WorkItemState.New,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    const legacyGraph = new WorkGraph(legacyStore);
    await legacyGraph.load();

    const c = await legacyGraph.createItem({ title: 'C' });
    expect(c.sortOrder).toBe(2);
  });

  it('reorders item from position 2 to position 0 (drag up inserts before target)', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });
    const c = await graph.createItem({ title: 'C' });

    await graph.reorderItem(c.id, a.id);

    const items = graph.getItemsByState(WorkItemState.New)
      .sort((x, y) => (x.sortOrder ?? Number.MAX_SAFE_INTEGER) - (y.sortOrder ?? Number.MAX_SAFE_INTEGER));
    expect(items.map((i) => i.title)).toEqual(['C', 'A', 'B']);
  });

  it('reorders item from position 0 to position 2 (drag down inserts after target)', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });
    const c = await graph.createItem({ title: 'C' });

    await graph.reorderItem(a.id, c.id);

    const items = graph.getItemsByState(WorkItemState.New)
      .sort((x, y) => (x.sortOrder ?? Number.MAX_SAFE_INTEGER) - (y.sortOrder ?? Number.MAX_SAFE_INTEGER));
    expect(items.map((i) => i.title)).toEqual(['B', 'C', 'A']);
  });

  it('dragging first item onto last places it at the end', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });
    const c = await graph.createItem({ title: 'C' });

    await graph.reorderItem(a.id, c.id);

    const items = graph.getItemsByState(WorkItemState.New)
      .sort((x, y) => (x.sortOrder ?? Number.MAX_SAFE_INTEGER) - (y.sortOrder ?? Number.MAX_SAFE_INTEGER));
    expect(items[items.length - 1].title).toBe('A');
  });

  it('reorder to same position is a no-op', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });

    const listener = vi.fn();
    graph.onDidChange(listener);

    await graph.reorderItem(a.id, a.id);

    expect(listener).not.toHaveBeenCalled();
  });

  it('reorder non-existent item is a no-op', async () => {
    const a = await graph.createItem({ title: 'A' });

    const listener = vi.fn();
    graph.onDidChange(listener);

    await graph.reorderItem('nonexistent', a.id);

    expect(listener).not.toHaveBeenCalled();
  });

  it('moveToEnd places item at end of its state group', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });
    const c = await graph.createItem({ title: 'C' });

    await graph.moveToEnd(a.id);

    const items = graph.getItemsByState(WorkItemState.New)
      .sort((x, y) => (x.sortOrder ?? Number.MAX_SAFE_INTEGER) - (y.sortOrder ?? Number.MAX_SAFE_INTEGER));
    expect(items.map((i) => i.title)).toEqual(['B', 'C', 'A']);
  });

  it('moveToEnd on non-existent item is a no-op', async () => {
    const listener = vi.fn();
    graph.onDidChange(listener);

    await graph.moveToEnd('nonexistent');

    expect(listener).not.toHaveBeenCalled();
  });

  it('reorder across different states is a no-op', async () => {
    const a = await graph.createItem({ title: 'A' });
    const b = await graph.createItem({ title: 'B' });
    await graph.transitionState(b.id, WorkItemState.InProgress);

    const listener = vi.fn();
    graph.onDidChange(listener);

    await graph.reorderItem(a.id, b.id);

    expect(listener).not.toHaveBeenCalled();
  });

  it('moves legacy items without sortOrder correctly', async () => {
    const legacyStore = createMockStore();

    await legacyStore.save({
      id: 'legacy-a',
      title: 'A',
      state: WorkItemState.New,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    await legacyStore.save({
      id: 'legacy-b',
      title: 'B',
      state: WorkItemState.New,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    const legacyGraph = new WorkGraph(legacyStore);
    await legacyGraph.load();

    const c = await legacyGraph.createItem({ title: 'C' });

    await legacyGraph.moveItem('legacy-a', 'down');

    const ordered = legacyGraph.getItemsByState(WorkItemState.New)
      .sort((x, y) => (x.sortOrder ?? Number.MAX_SAFE_INTEGER) - (y.sortOrder ?? Number.MAX_SAFE_INTEGER));
    expect(ordered.map((i) => i.title)).toEqual(['B', 'A', 'C']);
  });

  describe('provenance index', () => {
    it('finds item by provenance after createItem', async () => {
      const item = await graph.createItem(
        { title: 'Indexed' },
        { providerId: 'github', externalId: '42' },
      );

      const found = graph.findItemByProvenance('github', '42');
      expect(found).toBeDefined();
      expect(found!.id).toBe(item.id);
    });

    it('returns undefined for unknown provenance', () => {
      const found = graph.findItemByProvenance('github', 'missing');
      expect(found).toBeUndefined();
    });

    it('removes provenance entry on deleteItem', async () => {
      const item = await graph.createItem(
        { title: 'ToDelete' },
        { providerId: 'github', externalId: '99' },
      );
      expect(graph.findItemByProvenance('github', '99')).toBeDefined();

      await graph.deleteItem(item.id);
      expect(graph.findItemByProvenance('github', '99')).toBeUndefined();
    });

    it('rebuilds provenance index from store on load', async () => {
      const item = await graph.createItem(
        { title: 'Persisted' },
        { providerId: 'azdo', externalId: '7' },
      );

      const freshGraph = new WorkGraph(store);
      await freshGraph.load();

      const found = freshGraph.findItemByProvenance('azdo', '7');
      expect(found).toBeDefined();
      expect(found!.id).toBe(item.id);
    });
  });
});
