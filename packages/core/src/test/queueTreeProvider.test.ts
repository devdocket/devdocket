import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataTransfer, DataTransferItem } from 'vscode';
import { WorkGraph } from '../services/workGraph';
import { WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';
import { QueueTreeProvider } from '../views/queueTreeProvider';

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    saveAll: vi.fn(async (batch) => { for (const item of batch) { items.set(item.id, item); } }),
    delete: vi.fn(async (id) => { items.delete(id); }),
  };
}

const DRAG_MIME_TYPE = 'application/vnd.code.tree.workcenter.queue';

describe('QueueTreeProvider', () => {
  let store: ITaskStore;
  let graph: WorkGraph;
  let provider: QueueTreeProvider;

  beforeEach(async () => {
    store = createMockStore();
    graph = new WorkGraph(store);
    await graph.load();
    provider = new QueueTreeProvider(graph);
  });

  describe('getTreeItem', () => {
    it('sets treeItem.id to work item id', async () => {
      const item = await graph.createItem({ title: 'Test' });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.id).toBe(item.id);
    });
  });

  describe('handleDrag', () => {
    it('serializes dragged item ids into data transfer', async () => {
      const item = await graph.createItem({ title: 'Drag me' });
      const dataTransfer = new DataTransfer();

      provider.handleDrag([item], dataTransfer);

      const transferItem = dataTransfer.get(DRAG_MIME_TYPE);
      expect(transferItem).toBeDefined();
      expect(transferItem!.value).toEqual([item.id]);
    });
  });

  describe('handleDrop', () => {
    it('reorders when dropped on a target item', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });
      const c = await graph.createItem({ title: 'C' });

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem([c.id]));

      await provider.handleDrop(a, dataTransfer);

      const items = graph.getItemsByState(WorkItemState.New)
        .sort((x, y) => (x.sortOrder ?? Infinity) - (y.sortOrder ?? Infinity));
      expect(items.map((i) => i.title)).toEqual(['C', 'A', 'B']);
    });

    it('moves to end when dropped on empty space (target undefined)', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });
      const c = await graph.createItem({ title: 'C' });

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem([a.id]));

      await provider.handleDrop(undefined, dataTransfer);

      const items = graph.getItemsByState(WorkItemState.New)
        .sort((x, y) => (x.sortOrder ?? Infinity) - (y.sortOrder ?? Infinity));
      expect(items.map((i) => i.title)).toEqual(['B', 'C', 'A']);
    });

    it('ignores drop when no transfer item', async () => {
      const a = await graph.createItem({ title: 'A' });
      const dataTransfer = new DataTransfer();

      await provider.handleDrop(a, dataTransfer);
      // No error thrown, no-op
    });

    it('ignores drop when dragging multiple items', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem([a.id, b.id]));

      await provider.handleDrop(a, dataTransfer);
      // No error thrown, no-op
    });

    it('ignores drop on self', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });

      const listener = vi.fn();
      graph.onDidChange(listener);

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem([a.id]));

      await provider.handleDrop(a, dataTransfer);

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
