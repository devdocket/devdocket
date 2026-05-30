import { Buffer } from 'buffer';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { MAX_ACTIVITY_DETAIL_BYTES, WorkGraph } from '../services/workGraph';
import { setLogger } from '../services/logger';
import { WorkItemState } from '../models/workItem';
import { JsonTaskStore } from '../storage/jsonTaskStore';
import { JsonFileStore } from '../storage/fileStore';
import { ITaskStore } from '../storage/taskStore';
import { useMockFileSystem } from './testFileSystem';
import { decodeUpdatedDetail, UPDATED_DETAIL_VALUE_MAX_LENGTH, renderUpdatedActivityDetail } from '../services/updateDetail';

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
  let mockLogger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    setLogger(mockLogger);
    store = createMockStore();
    // WorkGraph uses vscode.EventEmitter — we need to mock it
    // Since we're running outside VS Code, mock the vscode module
    graph = new WorkGraph(store);
    await graph.load();
  });

  afterEach(() => {
    setLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
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

  it('generates IDs with wc- prefix followed by a valid UUID', async () => {
    const item = await graph.createItem({ title: 'UUID check' });
    const uuidPart = item.id.slice(3);
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(item.id).toMatch(/^wc-/);
    expect(uuidPart).toMatch(uuidV4Regex);
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

    await graph.transitionState(item.id, WorkItemState.Paused);
    expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Paused);

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

  it('increments related-items version only for title and membership changes', async () => {
    const initialVersion = graph.getRelatedItemsVersion();

    const first = await graph.createItem({ title: 'Original', notes: 'Notes' });
    expect(graph.getRelatedItemsVersion()).toBe(initialVersion + 1);

    await graph.updateItem(first.id, { notes: 'Updated notes' });
    expect(graph.getRelatedItemsVersion()).toBe(initialVersion + 1);

    await graph.updateItem(first.id, { description: 'Updated description' });
    expect(graph.getRelatedItemsVersion()).toBe(initialVersion + 1);

    await graph.updateItem(first.id, { url: 'https://example.com/updated' });
    expect(graph.getRelatedItemsVersion()).toBe(initialVersion + 1);

    await graph.transitionState(first.id, WorkItemState.InProgress);
    expect(graph.getRelatedItemsVersion()).toBe(initialVersion + 1);

    await graph.updateItem(first.id, { title: 'Updated title' });
    expect(graph.getRelatedItemsVersion()).toBe(initialVersion + 2);

    const second = await graph.createItem({ title: 'Second' });
    expect(graph.getRelatedItemsVersion()).toBe(initialVersion + 3);

    await graph.moveToTop(second.id);
    expect(graph.getRelatedItemsVersion()).toBe(initialVersion + 3);

    await graph.deleteItem(second.id);
    expect(graph.getRelatedItemsVersion()).toBe(initialVersion + 4);
  });

  it('serializes concurrent mutations so state and field updates both survive', async () => {
    useMockFileSystem();
    const fileUri = vscode.Uri.file('C:\\test\\workgraph-items.json');
    const realStore = new JsonTaskStore(new JsonFileStore(fileUri, 'workgraph-items.json'));
    const realGraph = new WorkGraph(realStore);
    await realGraph.load();
    const item = await realGraph.createItem({ title: 'A' });

    await Promise.all([
      realGraph.transitionState(item.id, WorkItemState.InProgress),
      realGraph.updateItem(item.id, { title: 'B' }),
    ]);

    const updated = realGraph.getItem(item.id);
    expect(updated?.state).toBe(WorkItemState.InProgress);
    expect(updated?.title).toBe('B');
    expect(updated?.activityLog?.map(entry => entry.type)).toEqual(['created', 'state-changed', 'updated']);

    await realGraph.flushPersistence();

    const freshGraph = new WorkGraph(new JsonTaskStore(new JsonFileStore(fileUri, 'workgraph-items.json')));
    await freshGraph.load();
    const persisted = freshGraph.getItem(item.id);
    expect(persisted?.state).toBe(WorkItemState.InProgress);
    expect(persisted?.title).toBe('B');
    expect(persisted?.activityLog?.map(entry => entry.type)).toEqual(['created', 'state-changed', 'updated']);
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

  it('bulk-accepts multiple inbox items with one save', async () => {
    const listener = vi.fn();
    graph.onDidChange(listener);

    const result = await graph.acceptManyFromInbox([
      { providerId: 'github', externalId: 'ext-1', title: 'Issue 1', description: 'First' },
      { providerId: 'github', externalId: 'ext-2', title: 'Issue 2', description: 'Second' },
    ]);

    expect(result.failures).toEqual([]);
    expect(result.accepted).toHaveLength(2);
    expect(store.saveAll).toHaveBeenCalledTimes(1);
    expect(store.save).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(graph.getAll()).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Issue 1', providerId: 'github', externalId: 'ext-1', state: WorkItemState.New, sortOrder: 0 }),
      expect.objectContaining({ title: 'Issue 2', providerId: 'github', externalId: 'ext-2', state: WorkItemState.New, sortOrder: 1 }),
    ]));
  });

  it('continues bulk accept after one invalid inbox item', async () => {
    const result = await graph.acceptManyFromInbox([
      { providerId: 'github', externalId: 'ext-1', title: 'Issue 1' },
      { providerId: 'github', externalId: '', title: 'Invalid issue' },
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toEqual(expect.objectContaining({ message: 'External ID is required' }));
    expect(store.saveAll).toHaveBeenCalledTimes(1);
    expect(graph.findItemByProvenance('github', 'ext-1')?.title).toBe('Issue 1');
    expect(graph.findItemByProvenance('github', '')).toBeUndefined();
  });

  it('preserves empty inbox titles during bulk accept', async () => {
    const result = await graph.acceptManyFromInbox([
      { providerId: 'github', externalId: 'empty-title', title: '   ', description: 'Untitled provider item' },
    ]);

    expect(result.failures).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(graph.findItemByProvenance('github', 'empty-title')).toEqual(expect.objectContaining({
      title: '   ',
      description: 'Untitled provider item',
    }));
  });

  it('coalesces bulk accept change events while preserving transition events', async () => {
    const existing = await graph.createItem(
      { title: 'Done item' },
      { providerId: 'github', externalId: 'done-1' },
    );
    await graph.transitionState(existing.id, WorkItemState.InProgress);
    await graph.transitionState(existing.id, WorkItemState.Done);
    vi.mocked(store.saveAll).mockClear();

    const changeListener = vi.fn();
    const transitionListener = vi.fn();
    graph.onDidChange(changeListener);
    graph.onDidTransitionState(transitionListener);

    const result = await graph.acceptManyFromInbox([
      { providerId: 'github', externalId: 'done-1', title: 'Done item' },
      { providerId: 'github', externalId: 'ext-2', title: 'New issue' },
    ]);

    expect(result.failures).toEqual([]);
    expect(store.saveAll).toHaveBeenCalledTimes(1);
    expect(changeListener).toHaveBeenCalledTimes(1);
    expect(transitionListener).toHaveBeenCalledTimes(1);
    expect(transitionListener).toHaveBeenCalledWith(expect.objectContaining({
      itemId: existing.id,
      oldState: WorkItemState.Done,
      newState: WorkItemState.New,
    }));
    expect(graph.getItem(existing.id)?.state).toBe(WorkItemState.New);
  });

  it('tags invalidateAndReload change events as external reloads', async () => {
    const listener = vi.fn();
    graph.onDidChange(listener);

    await graph.invalidateAndReload();

    expect(listener).toHaveBeenCalledWith({ source: 'externalReload' });
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

    it('persists provider item type from provenance', async () => {
      const item = await graph.createItem(
        { title: 'Indexed issue' },
        { providerId: 'github', externalId: '42', itemType: 'issue' },
      );

      expect(item.itemType).toBe('issue');
      expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ id: item.id, itemType: 'issue' }));
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

    it('keeps first item indexed when duplicates are created', async () => {
      const first = await graph.createItem(
        { title: 'First' },
        { providerId: 'gh', externalId: 'dup' },
      );
      const second = await graph.createItem(
        { title: 'Second' },
        { providerId: 'gh', externalId: 'dup' },
      );

      const found = graph.findItemByProvenance('gh', 'dup');
      expect(found).toBeDefined();
      expect(found!.id).toBe(first.id);
    });

    it('deleting unindexed duplicate does not remove indexed entry', async () => {
      const first = await graph.createItem(
        { title: 'First' },
        { providerId: 'gh', externalId: 'dup' },
      );
      const second = await graph.createItem(
        { title: 'Second' },
        { providerId: 'gh', externalId: 'dup' },
      );

      await graph.deleteItem(second.id);

      const found = graph.findItemByProvenance('gh', 'dup');
      expect(found).toBeDefined();
      expect(found!.id).toBe(first.id);
    });

    it('deleting indexed item re-points to remaining duplicate', async () => {
      const first = await graph.createItem(
        { title: 'First' },
        { providerId: 'gh', externalId: 'dup' },
      );
      const second = await graph.createItem(
        { title: 'Second' },
        { providerId: 'gh', externalId: 'dup' },
      );

      await graph.deleteItem(first.id);

      const found = graph.findItemByProvenance('gh', 'dup');
      expect(found).toBeDefined();
      expect(found!.id).toBe(second.id);
    });
  });

  describe('getItemsByState - multi-state and edge cases', () => {
    it('returns items matching multiple states', async () => {
      const a = await graph.createItem({ title: 'A' });
      await graph.transitionState(a.id, WorkItemState.InProgress);
      const b = await graph.createItem({ title: 'B' });
      await graph.transitionState(b.id, WorkItemState.InProgress);
      await graph.transitionState(b.id, WorkItemState.Paused);
      await graph.createItem({ title: 'C' }); // stays New

      const active = graph.getItemsByState(WorkItemState.InProgress, WorkItemState.Paused);
      expect(active).toHaveLength(2);
      expect(active.map((i) => i.title).sort()).toEqual(['A', 'B']);
    });

    it('returns empty array when called with no states', () => {
      expect(graph.getItemsByState()).toEqual([]);
    });

    it('returns consistent results on consecutive reads without mutations', async () => {
      await graph.createItem({ title: 'A' });
      const first = graph.getItemsByState(WorkItemState.New);
      const second = graph.getItemsByState(WorkItemState.New);
      expect(first).toEqual(second);
    });

    it('deduplicates when the same state is passed multiple times', async () => {
      await graph.createItem({ title: 'A' });
      await graph.createItem({ title: 'B' });
      const result = graph.getItemsByState(WorkItemState.New, WorkItemState.New);
      expect(result).toHaveLength(2);
    });
  });

  describe('state transition validation', () => {
    it('allows New → Done (e.g. auto-complete when external item is closed)', async () => {
      const item = await graph.createItem({ title: 'Test' });
      vi.mocked(store.save).mockClear();
      await graph.transitionState(item.id, WorkItemState.Done);
      expect(store.save).toHaveBeenCalled();
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Done);
    });

    it('allows New → Archived', async () => {
      const item = await graph.createItem({ title: 'Test' });
      vi.mocked(store.save).mockClear();
      await graph.transitionState(item.id, WorkItemState.Archived);
      expect(store.save).toHaveBeenCalled();
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Archived);
    });

    it('allows New → Paused (pause directly from Ready to Start)', async () => {
      const item = await graph.createItem({ title: 'Test' });
      vi.mocked(store.save).mockClear();
      await graph.transitionState(item.id, WorkItemState.Paused);
      expect(store.save).toHaveBeenCalled();
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Paused);
    });

    it('resumeItem returns a New-paused item back to New', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.Paused);
      await graph.resumeItem(item.id);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.New);
    });

    it('resumeItem returns an InProgress-paused item back to InProgress', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Paused);
      await graph.resumeItem(item.id);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.InProgress);
    });

    it('resumeItem uses the most recent pause origin when an item was paused twice', async () => {
      const item = await graph.createItem({ title: 'Test' });
      // First pause from New
      await graph.transitionState(item.id, WorkItemState.Paused);
      await graph.resumeItem(item.id);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.New);
      // Then move to InProgress and pause again — resume should now return to InProgress
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Paused);
      await graph.resumeItem(item.id);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.InProgress);
    });

    it('resumeItem rejects when the item is not paused', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await expect(graph.resumeItem(item.id)).rejects.toThrow('cannot resume');
    });

    it('resumeItem falls back to InProgress when no pause origin is found in the activity log', async () => {
      // Simulate a legacy paused item via the store directly, then reload.
      const legacyStore = createMockStore();
      const now = Date.now();
      await legacyStore.save({
        id: 'legacy-paused',
        title: 'Legacy paused item',
        state: WorkItemState.Paused,
        createdAt: now,
        updatedAt: now,
        activityLog: [{ timestamp: now, type: 'created' }],
      } as any);
      const legacyGraph = new WorkGraph(legacyStore);
      await legacyGraph.load();

      await legacyGraph.resumeItem('legacy-paused');
      expect(legacyGraph.getItem('legacy-paused')?.state).toBe(WorkItemState.InProgress);
    });

    it('allows Done → New (move back to queue)', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);
      vi.mocked(store.save).mockClear();
      await graph.transitionState(item.id, WorkItemState.New);
      expect(store.save).toHaveBeenCalled();
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.New);
    });

    it('rejects Done → InProgress', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);
      vi.mocked(store.save).mockClear();
      await expect(graph.transitionState(item.id, WorkItemState.InProgress))
        .rejects.toThrow('Invalid state transition');
      expect(store.save).not.toHaveBeenCalled();
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Done);
    });

    it('allows Archived → New (move back to queue)', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);
      await graph.transitionState(item.id, WorkItemState.Archived);
      vi.mocked(store.save).mockClear();
      await graph.transitionState(item.id, WorkItemState.New);
      expect(store.save).toHaveBeenCalled();
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.New);
    });

    it('allows InProgress → New (move to queue)', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      vi.mocked(store.save).mockClear();
      await graph.transitionState(item.id, WorkItemState.New);
      expect(store.save).toHaveBeenCalled();
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.New);
    });

    it('allows Paused → New (move to queue)', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Paused);
      vi.mocked(store.save).mockClear();
      await graph.transitionState(item.id, WorkItemState.New);
      expect(store.save).toHaveBeenCalled();
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.New);
    });

    it('assigns a fresh sortOrder when moving back to New', async () => {
      const itemA = await graph.createItem({ title: 'A' });
      const itemB = await graph.createItem({ title: 'B' });
      // Move A to InProgress (leaves B in Queue with sortOrder 1)
      await graph.transitionState(itemA.id, WorkItemState.InProgress);
      // Move A back to New — should get sortOrder after B
      await graph.transitionState(itemA.id, WorkItemState.New);
      const returned = graph.getItem(itemA.id)!;
      const remaining = graph.getItem(itemB.id)!;
      expect(returned.sortOrder).toBeGreaterThan(remaining.sortOrder!);
    });

    it('allows InProgress → Archived', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);

      await graph.transitionState(item.id, WorkItemState.Archived);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Archived);
    });

    it('allows Paused → Archived', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Paused);

      await graph.transitionState(item.id, WorkItemState.Archived);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Archived);
    });

    it('allows Paused → Done (e.g. auto-complete when external item is closed)', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Paused);

      await graph.transitionState(item.id, WorkItemState.Done);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Done);
    });

    it('rejects undefined state value', async () => {
      const item = await graph.createItem({ title: 'Test' });
      vi.mocked(store.save).mockClear();
      await expect(graph.transitionState(item.id, undefined as any))
        .rejects.toThrow('Invalid state value');
      expect(store.save).not.toHaveBeenCalled();
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.New);
    });

    it('allows all valid transitions in the full lifecycle', async () => {
      const item = await graph.createItem({ title: 'Lifecycle' });
      // New → InProgress
      await graph.transitionState(item.id, WorkItemState.InProgress);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.InProgress);
      // InProgress → Paused
      await graph.transitionState(item.id, WorkItemState.Paused);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Paused);
      // Paused → InProgress
      await graph.transitionState(item.id, WorkItemState.InProgress);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.InProgress);
      // InProgress → Done
      await graph.transitionState(item.id, WorkItemState.Done);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Done);
      // Done → Archived
      await graph.transitionState(item.id, WorkItemState.Archived);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.Archived);
    });
  });

  describe('move from History back to Queue', () => {
    it('moving Done item back to Queue appears in Queue view', async () => {
      const item = await graph.createItem({ title: 'Rework item' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);

      // Verify in History (Done state)
      const historyItems = graph.getItemsByState(WorkItemState.Done, WorkItemState.Archived);
      expect(historyItems).toHaveLength(1);
      expect(historyItems[0].id).toBe(item.id);

      // Move back to Queue
      await graph.transitionState(item.id, WorkItemState.New);

      // Verify in Queue view
      const queueItems = graph.getItemsByState(WorkItemState.New);
      expect(queueItems).toHaveLength(1);
      expect(queueItems[0].id).toBe(item.id);
    });

    it('moving Archived item back to Queue appears in Queue view', async () => {
      const item = await graph.createItem({ title: 'Archived rework' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);
      await graph.transitionState(item.id, WorkItemState.Archived);

      // Verify in History (Archived state)
      const historyItems = graph.getItemsByState(WorkItemState.Done, WorkItemState.Archived);
      expect(historyItems).toHaveLength(1);

      // Move back to Queue
      await graph.transitionState(item.id, WorkItemState.New);

      // Verify in Queue view
      const queueItems = graph.getItemsByState(WorkItemState.New);
      expect(queueItems).toHaveLength(1);
      expect(queueItems[0].id).toBe(item.id);
    });

    it('item no longer appears in History after move to Queue', async () => {
      const item = await graph.createItem({ title: 'Done item' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);

      // Move back to Queue
      await graph.transitionState(item.id, WorkItemState.New);

      // Verify NOT in History
      const historyItems = graph.getItemsByState(WorkItemState.Done, WorkItemState.Archived);
      expect(historyItems).toHaveLength(0);
    });

    it('Done → New assigns fresh sortOrder at end of Queue', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });
      const c = await graph.createItem({ title: 'C' });
      await graph.transitionState(a.id, WorkItemState.InProgress);
      await graph.transitionState(a.id, WorkItemState.Done);

      // Move Done item back to Queue
      await graph.transitionState(a.id, WorkItemState.New);

      const queueItems = graph.getItemsByState(WorkItemState.New)
        .sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0));
      expect(queueItems.map(i => i.title)).toEqual(['B', 'C', 'A']);
      expect(graph.getItem(a.id)!.sortOrder).toBeGreaterThan(graph.getItem(c.id)!.sortOrder!);
    });

    it('Archived → New assigns fresh sortOrder at end of Queue', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });
      await graph.transitionState(a.id, WorkItemState.InProgress);
      await graph.transitionState(a.id, WorkItemState.Done);
      await graph.transitionState(a.id, WorkItemState.Archived);

      // Move Archived item back to Queue
      await graph.transitionState(a.id, WorkItemState.New);

      const queueItems = graph.getItemsByState(WorkItemState.New)
        .sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0));
      expect(queueItems.map(i => i.title)).toEqual(['B', 'A']);
      expect(graph.getItem(a.id)!.sortOrder).toBeGreaterThan(graph.getItem(b.id)!.sortOrder!);
    });

    it('moving same Done item back to Queue twice works', async () => {
      const other = await graph.createItem({ title: 'Other item' });
      const item = await graph.createItem({ title: 'Rework twice' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);

      // First move back to Queue (should be after 'Other item')
      await graph.transitionState(item.id, WorkItemState.New);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.New);
      const firstSortOrder = graph.getItem(item.id)!.sortOrder;
      expect(firstSortOrder).toBeGreaterThan(graph.getItem(other.id)!.sortOrder!);

      // Complete again
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);

      // Second move back to Queue (should get an even higher sortOrder)
      await graph.transitionState(item.id, WorkItemState.New);
      expect(graph.getItem(item.id)?.state).toBe(WorkItemState.New);
      const secondSortOrder = graph.getItem(item.id)!.sortOrder;
      expect(secondSortOrder).toBeGreaterThan(firstSortOrder!);
    });

    it('fires onDidChange when moving History item to Queue', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);

      const listener = vi.fn();
      graph.onDidChange(listener);

      await graph.transitionState(item.id, WorkItemState.New);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('moving Done item to Queue updates sortOrder only', async () => {
      const item = await graph.createItem({ title: 'Original title', notes: 'Original notes' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);

      await graph.transitionState(item.id, WorkItemState.New);

      const updated = graph.getItem(item.id)!;
      expect(updated.title).toBe('Original title');
      expect(updated.notes).toBe('Original notes');
      expect(updated.sortOrder).toBeGreaterThanOrEqual(0);
    });

    it('multiple Done items moved back to Queue maintain relative order', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });
      const c = await graph.createItem({ title: 'C' });

      // Complete all three
      await graph.transitionState(a.id, WorkItemState.InProgress);
      await graph.transitionState(a.id, WorkItemState.Done);
      await graph.transitionState(b.id, WorkItemState.InProgress);
      await graph.transitionState(b.id, WorkItemState.Done);
      await graph.transitionState(c.id, WorkItemState.InProgress);
      await graph.transitionState(c.id, WorkItemState.Done);

      // Move back in order A, then B
      await graph.transitionState(a.id, WorkItemState.New);
      await graph.transitionState(b.id, WorkItemState.New);

      const queueItems = graph.getItemsByState(WorkItemState.New)
        .sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0));
      expect(queueItems.map(i => i.title)).toEqual(['A', 'B']);
      expect(graph.getItem(a.id)!.sortOrder).toBeLessThan(graph.getItem(b.id)!.sortOrder!);
    });
  });

  describe('clearOldHistory', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    async function createDoneItem(g: WorkGraph, title: string, daysAgo: number) {
      const item = await g.createItem({ title });
      await g.transitionState(item.id, WorkItemState.InProgress);
      await g.transitionState(item.id, WorkItemState.Done);
      // Backdated updatedAt to simulate age
      const updated = g.getItem(item.id)!;
      (updated as any).updatedAt = Date.now() - daysAgo * DAY_MS;
      return updated;
    }

    async function createArchivedItem(g: WorkGraph, title: string, daysAgo: number) {
      const item = await createDoneItem(g, title, daysAgo);
      await g.transitionState(item.id, WorkItemState.Archived);
      const updated = g.getItem(item.id)!;
      (updated as any).updatedAt = Date.now() - daysAgo * DAY_MS;
      return updated;
    }

    it('deletes items older than threshold', async () => {
      await createDoneItem(graph, 'Old', 60);
      await createDoneItem(graph, 'Recent', 5);

      const result = await graph.clearOldHistory(30);

      expect(result.deleted).toBe(1);
      expect(graph.getItemsByState(WorkItemState.Done)).toHaveLength(1);
      expect(graph.getItemsByState(WorkItemState.Done)[0].title).toBe('Recent');
    });

    it('deletes Archived items older than threshold', async () => {
      await createArchivedItem(graph, 'Old archived', 90);
      await createDoneItem(graph, 'Recent done', 5);

      const result = await graph.clearOldHistory(30);

      expect(result.deleted).toBe(1);
      expect(graph.getItemsByState(WorkItemState.Archived)).toHaveLength(0);
    });

    it('does not affect InProgress or New items', async () => {
      const item = await graph.createItem({ title: 'New item' });
      (item as any).updatedAt = Date.now() - 60 * DAY_MS;
      const ip = await graph.createItem({ title: 'In progress' });
      await graph.transitionState(ip.id, WorkItemState.InProgress);
      (graph.getItem(ip.id)! as any).updatedAt = Date.now() - 60 * DAY_MS;

      const result = await graph.clearOldHistory(30);

      expect(result.deleted).toBe(0);
      expect(graph.getItem(item.id)).toBeDefined();
      expect(graph.getItem(ip.id)).toBeDefined();
    });

    it('uses updatedAt not createdAt for cutoff', async () => {
      const item = await graph.createItem({ title: 'Old created, recently updated' });
      (item as any).createdAt = Date.now() - 90 * DAY_MS;
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);
      // updatedAt is recent (just transitioned)

      const result = await graph.clearOldHistory(30);

      expect(result.deleted).toBe(0);
      expect(graph.getItem(item.id)).toBeDefined();
    });

    it('returns 0 when no history items exist', async () => {
      const result = await graph.clearOldHistory(30);
      expect(result.deleted).toBe(0);
    });

    it('handles boundary: item exactly at cutoff is not deleted', async () => {
      vi.useFakeTimers();
      const now = new Date('2025-06-15T12:00:00Z').getTime();
      vi.setSystemTime(now);
      try {
        const item = await createDoneItem(graph, 'Boundary', 30);
        (item as any).updatedAt = now - 30 * DAY_MS;

        const result = await graph.clearOldHistory(30);

        // At exactly the cutoff, updatedAt === cutoff, filter is <, so not deleted
        expect(result.deleted).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('continues deleting after a single item fails', async () => {
      const old1 = await createDoneItem(graph, 'Old1', 60);
      await createDoneItem(graph, 'Old2', 60);

      const origImpl = (store.delete as ReturnType<typeof vi.fn>).getMockImplementation()!;
      let callCount = 0;
      (store.delete as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
        callCount++;
        if (id === old1.id) {
          throw new Error('disk full');
        }
        return origImpl(id);
      });

      const result = await graph.clearOldHistory(30);

      expect(result.deleted).toBe(1);
      expect(result.failed).toBe(1);
      expect(callCount).toBe(2);
      // Old1 should still exist (delete failed before items.delete ran)
      expect(graph.getItem(old1.id)).toBeDefined();
      // Old2 should be deleted
      expect(graph.getItemsByState(WorkItemState.Done)).toHaveLength(1);
      expect(graph.getItemsByState(WorkItemState.Done)[0].id).toBe(old1.id);
    });

    it('fires onDidChange only once for batch deletion', async () => {
      await createDoneItem(graph, 'Old1', 60);
      await createDoneItem(graph, 'Old2', 60);
      await createDoneItem(graph, 'Old3', 60);

      const changeSpy = vi.fn();
      graph.onDidChange(changeSpy);
      changeSpy.mockClear();

      await graph.clearOldHistory(30);

      expect(changeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('activity log', () => {
    it('records a created entry on createItem', async () => {
      const item = await graph.createItem({ title: 'Test' });

      expect(item.activityLog).toHaveLength(1);
      expect(item.activityLog![0].type).toBe('created');
      expect(item.activityLog![0].timestamp).toBeGreaterThan(0);
    });

    it('records a state-changed entry on transitionState', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);

      const updated = graph.getItem(item.id);
      expect(updated?.activityLog).toHaveLength(2);
      expect(updated!.activityLog![1].type).toBe('state-changed');
      expect(updated!.activityLog![1].detail).toBe('New → InProgress');
    });

    it('records an updated entry on updateItem', async () => {
      const item = await graph.createItem({ title: 'Original' });
      await graph.updateItem(item.id, { title: 'Updated' });

      const updated = graph.getItem(item.id);
      expect(updated?.activityLog).toHaveLength(2);
      expect(updated!.activityLog![1].type).toBe('updated');
      expect(decodeUpdatedDetail(updated!.activityLog![1].detail)).toEqual({
        kind: 'v1',
        detail: {
          v: 1,
          changes: {
            title: { from: 'Original', to: 'Updated' },
          },
        },
      });
    });

    it('records changed fields in update detail', async () => {
      const item = await graph.createItem({ title: 'Original', notes: 'some notes' });
      await graph.updateItem(item.id, { title: 'New title', notes: 'new notes' });

      const updated = graph.getItem(item.id);
      expect(decodeUpdatedDetail(updated!.activityLog![1].detail)).toEqual({
        kind: 'v1',
        detail: {
          v: 1,
          changes: {
            title: { from: 'Original', to: 'New title' },
            notes: { from: 'some notes', to: 'new notes' },
          },
        },
      });
    });

    it('truncates oversized field diffs in update detail', async () => {
      const originalNotes = 'a'.repeat(UPDATED_DETAIL_VALUE_MAX_LENGTH + 10);
      const updatedNotes = 'b'.repeat(UPDATED_DETAIL_VALUE_MAX_LENGTH + 25);
      const item = await graph.createItem({ title: 'Original', notes: originalNotes });
      await graph.updateItem(item.id, { notes: updatedNotes });

      const updated = graph.getItem(item.id);
      expect(decodeUpdatedDetail(updated!.activityLog![1].detail)).toEqual({
        kind: 'v1',
        detail: {
          v: 1,
          changes: {
            notes: {
              from: `${'a'.repeat(UPDATED_DETAIL_VALUE_MAX_LENGTH - 1)}…`,
              to: `${'b'.repeat(UPDATED_DETAIL_VALUE_MAX_LENGTH - 1)}…`,
            },
          },
        },
      });
    });

    it('omits provider-synced description values from update detail', async () => {
      const item = await graph.createItem({ title: 'Original', description: 'Old provider description' });
      await graph.updateItem(item.id, { description: 'New provider description' }, { source: 'provider-sync' });

      const updated = graph.getItem(item.id);
      expect(decodeUpdatedDetail(updated!.activityLog![1].detail)).toEqual({
        kind: 'v1',
        detail: {
          v: 1,
          changes: {
            description: {},
          },
        },
      });
      expect(renderUpdatedActivityDetail(updated!.activityLog![1].detail)).toEqual({
        kind: 'fields',
        rows: [{ label: 'Description', value: 'value changed' }],
      });
    });

    it('does not record empty-to-empty changes when clearing optional fields', async () => {
      const item = await graph.createItem({ title: 'Original' });
      const listener = vi.fn();
      graph.onDidChange(listener);
      (store.save as ReturnType<typeof vi.fn>).mockClear();

      await graph.updateItem(item.id, { notes: '' });

      expect(graph.getItem(item.id)?.activityLog).toHaveLength(1);
      expect(store.save).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not record update entry when no fields actually changed', async () => {
      const item = await graph.createItem({ title: 'Same' });
      const listener = vi.fn();
      graph.onDidChange(listener);
      (store.save as ReturnType<typeof vi.fn>).mockClear();

      await graph.updateItem(item.id, { title: 'Same' });

      const updated = graph.getItem(item.id);
      // Only the initial 'created' entry should exist — no 'updated' entry
      expect(updated?.activityLog).toHaveLength(1);
      expect(updated!.activityLog![0].type).toBe('created');
      // No save or event should fire for a no-op update
      expect(store.save).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });

    it('appends entries via addActivity', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.addActivity(item.id, 'action-executed', 'branch created');

      const updated = graph.getItem(item.id);
      expect(updated?.activityLog).toHaveLength(2);
      expect(updated!.activityLog![1].type).toBe('action-executed');
      expect(updated!.activityLog![1].detail).toBe('branch created');
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('truncates oversized addActivity detail and logs a warning', async () => {
      const item = await graph.createItem({ title: 'Test' });
      const oversizedDetail = 'x'.repeat(MAX_ACTIVITY_DETAIL_BYTES + 1);

      await graph.addActivity(item.id, 'action-executed', oversizedDetail);

      const updated = graph.getItem(item.id);
      const detail = updated!.activityLog![1].detail;
      expect(detail).toBeDefined();
      expect(detail).not.toBe(oversizedDetail);
      expect(detail).toMatch(/…\[truncated\]$/);
      expect(Buffer.byteLength(detail!, 'utf8')).toBeLessThanOrEqual(MAX_ACTIVITY_DETAIL_BYTES);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('an unknown extension'));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('was truncated'));
    });

    it('truncates oversized multi-byte addActivity detail on a code-point boundary', async () => {
      const item = await graph.createItem({ title: 'Test' });
      // 4-byte UTF-8 codepoint (party popper emoji). Each emoji is 2 UTF-16 units
      // but 4 UTF-8 bytes, so a naive UTF-16 substring would split surrogate pairs.
      const emoji = '🎉';
      const emojiByteLen = Buffer.byteLength(emoji, 'utf8'); // 4
      const oversizedDetail = emoji.repeat(Math.ceil(MAX_ACTIVITY_DETAIL_BYTES / emojiByteLen) + 10);
      expect(Buffer.byteLength(oversizedDetail, 'utf8')).toBeGreaterThan(MAX_ACTIVITY_DETAIL_BYTES);

      await graph.addActivity(item.id, 'action-executed', oversizedDetail);

      const updated = graph.getItem(item.id);
      const detail = updated!.activityLog![1].detail!;
      expect(detail).toMatch(/…\[truncated\]$/);
      expect(Buffer.byteLength(detail, 'utf8')).toBeLessThanOrEqual(MAX_ACTIVITY_DETAIL_BYTES);
      // Stripped of suffix, the prefix must still consist of whole emoji code points
      // (no broken surrogate pair / mojibake). Round-tripping confirms valid UTF-8.
      const prefix = detail.slice(0, detail.length - '…[truncated]'.length);
      const roundTripped = Buffer.from(prefix, 'utf8').toString('utf8');
      expect(roundTripped).toBe(prefix);
      // Every char in the prefix should be the full emoji (no half-surrogate left behind).
      for (const ch of prefix) {
        expect(ch).toBe(emoji);
      }
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('was truncated'));
    });

    it('addActivity without detail omits the detail field', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.addActivity(item.id, 'action-executed');

      const updated = graph.getItem(item.id);
      expect(updated!.activityLog![1].detail).toBeUndefined();
    });

    it('addActivity throws for unknown item', async () => {
      await expect(graph.addActivity('nonexistent', 'action-executed'))
        .rejects.toThrow('Work item not found');
    });

    it('addActivity fires onDidChange', async () => {
      const item = await graph.createItem({ title: 'Test' });
      const listener = vi.fn();
      graph.onDidChange(listener);

      await graph.addActivity(item.id, 'action-executed');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('trims log to MAX_ACTIVITY_LOG_ENTRIES', async () => {
      const { MAX_ACTIVITY_LOG_ENTRIES } = await import('../models/activityLog');
      const item = await graph.createItem({ title: 'Test' });

      // Already has 1 entry from creation
      for (let i = 1; i < MAX_ACTIVITY_LOG_ENTRIES + 10; i++) {
        await graph.addActivity(item.id, 'action-executed', `entry ${i}`);
      }

      const updated = graph.getItem(item.id);
      expect(updated!.activityLog).toHaveLength(MAX_ACTIVITY_LOG_ENTRIES);
      // Oldest entries should have been trimmed; newest should be present
      const lastEntry = updated!.activityLog![MAX_ACTIVITY_LOG_ENTRIES - 1];
      expect(lastEntry.detail).toBe(`entry ${MAX_ACTIVITY_LOG_ENTRIES + 9}`);
    });

    it('accumulates entries across lifecycle transitions', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);

      const updated = graph.getItem(item.id);
      expect(updated?.activityLog).toHaveLength(3);
      expect(updated!.activityLog!.map(e => e.type)).toEqual([
        'created', 'state-changed', 'state-changed',
      ]);
    });

    it('persists activity log through store save', async () => {
      const item = await graph.createItem({ title: 'Test' });
      await graph.addActivity(item.id, 'action-executed', 'saved data');

      expect(store.save).toHaveBeenCalled();
      const savedItem = (store.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
      expect(savedItem.activityLog).toHaveLength(2);
    });
  });

  describe('onDidTransitionState event', () => {
    it('fires with correct payload on state transition', async () => {
      const listener = vi.fn();
      graph.onDidTransitionState(listener);

      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0];
      expect(event.itemId).toBe(item.id);
      expect(event.oldState).toBe('New');
      expect(event.newState).toBe('InProgress');
      expect(event.item.state).toBe(WorkItemState.InProgress);
    });

    it('fires for each transition in a lifecycle', async () => {
      const listener = vi.fn();
      graph.onDidTransitionState(listener);

      const item = await graph.createItem({ title: 'Test' });
      await graph.transitionState(item.id, WorkItemState.InProgress);
      await graph.transitionState(item.id, WorkItemState.Done);

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener.mock.calls[0][0].newState).toBe('InProgress');
      expect(listener.mock.calls[1][0].newState).toBe('Done');
    });

    it('does not fire for non-transition operations', async () => {
      const listener = vi.fn();
      graph.onDidTransitionState(listener);

      await graph.createItem({ title: 'Test' });
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
