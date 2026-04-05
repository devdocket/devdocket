import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataTransfer, DataTransferItem, TreeItemCollapsibleState } from 'vscode';
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

  describe('getChildren', () => {
    it('returns empty array when queue has no items', () => {
      expect(provider.getChildren()).toEqual([]);
    });

    it('returns a single item', async () => {
      const item = await graph.createItem({ title: 'Only one' });
      const children = provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(item.id);
    });

    it('returns items sorted by sortOrder ascending', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });
      const c = await graph.createItem({ title: 'C' });

      const children = provider.getChildren();
      expect(children.map(i => i.title)).toEqual(['A', 'B', 'C']);
    });

    it('places items without sortOrder at the end', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });

      // Manually clear sortOrder on 'A' to simulate a missing value
      const raw = graph.getItemsByState(WorkItemState.New).find(i => i.id === a.id)!;
      (raw as any).sortOrder = undefined;

      const children = provider.getChildren();
      // 'B' has a sortOrder, 'A' does not → 'B' first
      expect(children[0].title).toBe('B');
    });

    it('only returns items in New state', async () => {
      const item = await graph.createItem({ title: 'Queued' });
      await graph.transitionState(item.id, WorkItemState.InProgress);

      const children = provider.getChildren();
      expect(children).toHaveLength(0);
    });
  });

  describe('getTreeItem', () => {
    it('sets treeItem.id to work item id', async () => {
      const item = await graph.createItem({ title: 'Test' });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.id).toBe(item.id);
    });

    it('sets label to the item title', async () => {
      const item = await graph.createItem({ title: 'My Task' });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.label).toBe('My Task');
    });

    it('sets collapsibleState to None', async () => {
      const item = await graph.createItem({ title: 'Flat' });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.None);
    });

    it('sets description to providerId', async () => {
      const item = await graph.createItem({ title: 'From provider' });
      // Manually set providerId since createItem doesn't accept it
      (item as any).providerId = 'github';
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.description).toBe('github');
    });

    it('sets description to undefined when no providerId', async () => {
      const item = await graph.createItem({ title: 'Manual' });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.description).toBeUndefined();
    });

    it('sets contextValue to "queueItem.hasUrl" when item has url', async () => {
      const item = await graph.createItem({ title: 'With URL' });
      (item as any).url = 'https://github.com/issue/1';
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.contextValue).toBe('queueItem.hasUrl');
    });

    it('sets contextValue to "queueItem" when item has no url', async () => {
      const item = await graph.createItem({ title: 'No URL' });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.contextValue).toBe('queueItem');
    });

    it('sets icon to "remote" when item has providerId', async () => {
      const item = await graph.createItem({ title: 'Provider item' });
      (item as any).providerId = 'github';
      const treeItem = provider.getTreeItem(item);
      expect((treeItem.iconPath as any).id).toBe('remote');
    });

    it('sets icon to "circle-filled" when item has no providerId', async () => {
      const item = await graph.createItem({ title: 'Manual item' });
      const treeItem = provider.getTreeItem(item);
      expect((treeItem.iconPath as any).id).toBe('circle-filled');
    });

    it('builds tooltip with title in bold', async () => {
      const item = await graph.createItem({ title: 'Important' });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.tooltip.value).toContain('**Important**');
    });

    it('includes notes in tooltip when present', async () => {
      const item = await graph.createItem({ title: 'With notes' });
      (item as any).notes = 'Some detailed notes';
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.tooltip.value).toContain('Some detailed notes');
    });

    it('includes created date in tooltip', async () => {
      const item = await graph.createItem({ title: 'Dated' });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.tooltip.value).toContain('Created:');
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

    it('serializes multiple dragged item ids', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });
      const dataTransfer = new DataTransfer();

      provider.handleDrag([a, b], dataTransfer);

      const transferItem = dataTransfer.get(DRAG_MIME_TYPE);
      expect(transferItem!.value).toEqual([a.id, b.id]);
    });

    it('uses the correct MIME type', async () => {
      const item = await graph.createItem({ title: 'Check MIME' });
      const dataTransfer = new DataTransfer();

      provider.handleDrag([item], dataTransfer);

      expect(dataTransfer.get(DRAG_MIME_TYPE)).toBeDefined();
      expect(dataTransfer.get('text/plain')).toBeUndefined();
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

      const items = provider.getChildren();
      expect(items.map((i) => i.title)).toEqual(['C', 'A', 'B']);
    });

    it('moves to end when dropped on empty space (target undefined)', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });
      const c = await graph.createItem({ title: 'C' });

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem([a.id]));

      await provider.handleDrop(undefined, dataTransfer);

      const items = provider.getChildren();
      expect(items.map((i) => i.title)).toEqual(['B', 'C', 'A']);
    });

    it('ignores drop when no transfer item', async () => {
      const a = await graph.createItem({ title: 'A' });
      const dataTransfer = new DataTransfer();

      await provider.handleDrop(a, dataTransfer);
      // No error, no-op
    });

    it('ignores drop when dragging multiple items', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem([a.id, b.id]));

      // Order should remain unchanged
      await provider.handleDrop(a, dataTransfer);
      const items = provider.getChildren();
      expect(items.map(i => i.title)).toEqual(['A', 'B']);
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

    it('ignores drop when transfer value is not an array', async () => {
      const a = await graph.createItem({ title: 'A' });

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem('not-an-array'));

      await provider.handleDrop(a, dataTransfer);
      // No error, no-op
    });

    it('ignores drop when transfer value contains non-string', async () => {
      const a = await graph.createItem({ title: 'A' });

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem([123]));

      await provider.handleDrop(a, dataTransfer);
      // No error, no-op
    });

    it('reorders middle item to front', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });
      const c = await graph.createItem({ title: 'C' });

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem([b.id]));

      await provider.handleDrop(a, dataTransfer);

      const items = provider.getChildren();
      expect(items.map(i => i.title)).toEqual(['B', 'A', 'C']);
    });

    it('reorders last item to middle', async () => {
      const a = await graph.createItem({ title: 'A' });
      const b = await graph.createItem({ title: 'B' });
      const c = await graph.createItem({ title: 'C' });

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem([c.id]));

      await provider.handleDrop(b, dataTransfer);

      const items = provider.getChildren();
      expect(items.map(i => i.title)).toEqual(['A', 'C', 'B']);
    });

    it('handles drop with single-item queue gracefully', async () => {
      const a = await graph.createItem({ title: 'Only' });

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem([a.id]));

      // Drop on self — should be a no-op
      await provider.handleDrop(a, dataTransfer);
      const items = provider.getChildren();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Only');
    });

    it('handles drop to end with single-item queue', async () => {
      const a = await graph.createItem({ title: 'Only' });

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem([a.id]));

      await provider.handleDrop(undefined, dataTransfer);
      const items = provider.getChildren();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Only');
    });
  });

  describe('events', () => {
    it('fires onDidChangeTreeData when workGraph changes', async () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      await graph.createItem({ title: 'Trigger change' });
      expect(listener).toHaveBeenCalled();
    });

    it('fires onDidChangeTreeData on refresh()', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      provider.refresh();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires event for each workGraph change', async () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      await graph.createItem({ title: 'First' });
      await graph.createItem({ title: 'Second' });
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  describe('drag/drop mime types', () => {
    it('exposes correct dropMimeTypes', () => {
      expect(provider.dropMimeTypes).toEqual([DRAG_MIME_TYPE]);
    });

    it('exposes correct dragMimeTypes', () => {
      expect(provider.dragMimeTypes).toEqual([DRAG_MIME_TYPE]);
    });
  });

  describe('dispose', () => {
    it('cleans up without error', () => {
      expect(() => provider.dispose()).not.toThrow();
    });

    it('stops forwarding workGraph events after dispose', async () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      provider.dispose();
      await graph.createItem({ title: 'After dispose' });

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
