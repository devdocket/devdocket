import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataTransfer, DataTransferItem, EventEmitter, MarkdownString, TreeItemCollapsibleState } from 'vscode';
import { WorkGraph } from '../services/workGraph';
import { WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';
import { QueueTreeProvider } from '../views/queueTreeProvider';
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

function createMockProviderRegistry(): ProviderRegistry {
  const emitter = new EventEmitter<void>();
  return {
    getProviderLabel: vi.fn((id: string) => {
      if (id === 'github') return 'GitHub Issues';
      if (id === 'ado') return 'Azure DevOps';
      return id;
    }),
    onDidRegisterProvider: emitter.event,
  } as any;
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

      // Force out-of-order sortOrder to verify actual sorting
      a.sortOrder = 30;
      b.sortOrder = 10;
      c.sortOrder = 20;

      const children = provider.getChildren();
      expect(children.map(i => i.title)).toEqual(['B', 'C', 'A']);
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

    it('sets description to providerId when no label resolver', async () => {
      const item = await graph.createItem(
        { title: 'From provider' },
        { providerId: 'github', externalId: 'ext-1' },
      );
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.description).toBe('github');
    });

    it('sets description to undefined when no providerId', async () => {
      const item = await graph.createItem({ title: 'Manual' });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.description).toBeUndefined();
    });

    it('sets contextValue to "queueItem.hasUrl" when item has url', async () => {
      const item = await graph.createItem(
        { title: 'With URL' },
        { providerId: 'github', externalId: 'ext-2', url: 'https://github.com/issue/1' },
      );
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.contextValue).toBe('queueItem.hasUrl');
    });

    it('sets contextValue to "queueItem" when item has no url', async () => {
      const item = await graph.createItem({ title: 'No URL' });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.contextValue).toBe('queueItem');
    });

    it('sets icon to "remote" when item has providerId', async () => {
      const item = await graph.createItem(
        { title: 'Provider item' },
        { providerId: 'github', externalId: 'ext-3' },
      );
      const treeItem = provider.getTreeItem(item);
      expect((treeItem.iconPath as any).id).toBe('remote');
    });

    it('sets icon to "circle-filled" when item has no providerId', async () => {
      const item = await graph.createItem({ title: 'Manual item' });
      const treeItem = provider.getTreeItem(item);
      expect((treeItem.iconPath as any).id).toBe('circle-filled');
    });

    it('builds tooltip with title label and title text', async () => {
      const item = await graph.createItem({ title: 'Important' });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.tooltip.value).toContain('**Title:** ');
      expect(treeItem.tooltip.value).toContain('Important');
    });

    it('includes notes in tooltip when present', async () => {
      const item = await graph.createItem({ title: 'With notes' });
      item.notes = 'Some detailed notes';
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.tooltip.value).toContain('Some detailed notes');
    });

    it('includes created date in tooltip', async () => {
      const item = await graph.createItem({ title: 'Dated' });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.tooltip.value).toContain('Created:');
    });

    it('uses appendText for title to prevent markdown injection', async () => {
      const maliciousTitle = '[Click me](command:workbench.action.terminal.sendSequence)';
      const item = await graph.createItem({ title: maliciousTitle });

      const appendTextSpy = vi.spyOn(MarkdownString.prototype, 'appendText');
      const appendMarkdownSpy = vi.spyOn(MarkdownString.prototype, 'appendMarkdown');

      provider.getTreeItem(item);

      const textCalls = appendTextSpy.mock.calls.map(c => c[0]);
      const mdCalls = appendMarkdownSpy.mock.calls.map(c => c[0]);

      expect(textCalls).toContainEqual(maliciousTitle);
      expect(mdCalls).not.toContainEqual(maliciousTitle);

      appendTextSpy.mockRestore();
      appendMarkdownSpy.mockRestore();
    });

    it('uses appendText for notes to prevent markdown injection', async () => {
      const maliciousNotes = '![img](https://evil.com/track.png)';
      const item = await graph.createItem({ title: 'Safe title' });
      item.notes = maliciousNotes;

      const appendTextSpy = vi.spyOn(MarkdownString.prototype, 'appendText');
      const appendMarkdownSpy = vi.spyOn(MarkdownString.prototype, 'appendMarkdown');

      provider.getTreeItem(item);

      const textCalls = appendTextSpy.mock.calls.map(c => c[0]);
      const mdCalls = appendMarkdownSpy.mock.calls.map(c => c[0]);

      expect(textCalls).toContainEqual(expect.stringContaining(maliciousNotes));
      expect(mdCalls).not.toContainEqual(expect.stringContaining(maliciousNotes));

      appendTextSpy.mockRestore();
      appendMarkdownSpy.mockRestore();
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

  describe('resolveTitle', () => {
    function createMockProviderRegistry(discoveredItems: Map<string, Array<{ externalId: string; title: string }>> = new Map()) {
      const emitter = new EventEmitter();
      const changeEmitter = new EventEmitter();
      return {
        getProviderLabel: vi.fn((id: string) => id),
        onDidRegisterProvider: emitter.event,
        onDidChangeDiscoveredItems: changeEmitter.event,
        getDiscoveredItems: vi.fn((providerId: string) => discoveredItems.get(providerId) ?? []),
        _fireChange: () => changeEmitter.fire(),
      };
    }

    it('shows live title from provider for provider-backed items', async () => {
      const discovered = new Map([
        ['github', [{ externalId: 'ext-1', title: 'Live Title from GitHub' }]],
      ]);
      const registry = createMockProviderRegistry(discovered);
      const providerAwareProvider = new QueueTreeProvider(graph, registry as any);

      const item = await graph.createItem(
        { title: 'Persisted Title' },
        { providerId: 'github', externalId: 'ext-1' },
      );

      const treeItem = providerAwareProvider.getTreeItem(item);
      expect(treeItem.label).toBe('Live Title from GitHub');
    });

    it('shows persisted title for items without a provider', async () => {
      const registry = createMockProviderRegistry();
      const providerAwareProvider = new QueueTreeProvider(graph, registry as any);

      const item = await graph.createItem({ title: 'Manual Task' });

      const treeItem = providerAwareProvider.getTreeItem(item);
      expect(treeItem.label).toBe('Manual Task');
    });

    it('falls back to persisted title when discovered item does not exist', async () => {
      const discovered = new Map([
        ['github', [{ externalId: 'different-id', title: 'Other Item' }]],
      ]);
      const registry = createMockProviderRegistry(discovered);
      const providerAwareProvider = new QueueTreeProvider(graph, registry as any);

      const item = await graph.createItem(
        { title: 'Persisted Fallback' },
        { providerId: 'github', externalId: 'ext-not-found' },
      );

      const treeItem = providerAwareProvider.getTreeItem(item);
      expect(treeItem.label).toBe('Persisted Fallback');
    });

    it('falls back to persisted title when provider has no discovered items', async () => {
      const registry = createMockProviderRegistry(new Map());
      const providerAwareProvider = new QueueTreeProvider(graph, registry as any);

      const item = await graph.createItem(
        { title: 'Persisted Only' },
        { providerId: 'github', externalId: 'ext-1' },
      );

      const treeItem = providerAwareProvider.getTreeItem(item);
      expect(treeItem.label).toBe('Persisted Only');
    });

    it('uses persisted title when no providerRegistry is provided', async () => {
      // provider is already created without registry in beforeEach
      const item = await graph.createItem(
        { title: 'No Registry' },
        { providerId: 'github', externalId: 'ext-1' },
      );

      const treeItem = provider.getTreeItem(item);
      expect(treeItem.label).toBe('No Registry');
    });

    it('includes resolved title in tooltip', async () => {
      const discovered = new Map([
        ['github', [{ externalId: 'ext-1', title: 'Live Tooltip Title' }]],
      ]);
      const registry = createMockProviderRegistry(discovered);
      const providerAwareProvider = new QueueTreeProvider(graph, registry as any);

      const item = await graph.createItem(
        { title: 'Persisted Title' },
        { providerId: 'github', externalId: 'ext-1' },
      );

      const treeItem = providerAwareProvider.getTreeItem(item);
      expect(treeItem.tooltip.value).toContain('Live Tooltip Title');
      expect(treeItem.tooltip.value).not.toContain('Persisted Title');
    });

    it('refreshes tree when discovered items change', async () => {
      const discovered = new Map<string, Array<{ externalId: string; title: string }>>();
      const registry = createMockProviderRegistry(discovered);
      const providerAwareProvider = new QueueTreeProvider(graph, registry as any);

      const listener = vi.fn();
      providerAwareProvider.onDidChangeTreeData(listener);

      registry._fireChange();
      expect(listener).toHaveBeenCalledTimes(1);
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

  describe('provider label resolution', () => {
    let providerRegistry: ProviderRegistry;
    let providerWithResolver: QueueTreeProvider;

    beforeEach(async () => {
      providerRegistry = createMockProviderRegistry();
      providerWithResolver = new QueueTreeProvider(graph, providerRegistry);
    });

    it('should show resolved label instead of raw providerId for GitHub items', async () => {
      const item = await graph.createItem(
        { title: 'GitHub Issue' },
        { providerId: 'github', externalId: 'issue-123' },
      );
      const treeItem = providerWithResolver.getTreeItem(item);
      expect(treeItem.description).toBe('GitHub Issues');
    });

    it('should show resolved label instead of raw providerId for ADO items', async () => {
      const item = await graph.createItem(
        { title: 'ADO Work Item' },
        { providerId: 'ado', externalId: 'workitem-456' },
      );
      const treeItem = providerWithResolver.getTreeItem(item);
      expect(treeItem.description).toBe('Azure DevOps');
    });

    it('should show undefined description for items without providerId', async () => {
      const item = await graph.createItem({ title: 'Manual item' });
      const treeItem = providerWithResolver.getTreeItem(item);
      expect(treeItem.description).toBeUndefined();
    });

    it('should call getProviderLabel with correct providerId', async () => {
      const item = await graph.createItem(
        { title: 'Test' },
        { providerId: 'github', externalId: 'ext-1' },
      );
      providerWithResolver.getTreeItem(item);
      expect(providerRegistry.getProviderLabel).toHaveBeenCalledWith('github');
    });

    it('should not call getProviderLabel for items without providerId', async () => {
      const item = await graph.createItem({ title: 'Manual' });
      (providerRegistry.getProviderLabel as ReturnType<typeof vi.fn>).mockClear();
      providerWithResolver.getTreeItem(item);
      expect(providerRegistry.getProviderLabel).not.toHaveBeenCalled();
    });

    it('should fall back to raw providerId if resolver returns undefined', async () => {
      (providerRegistry.getProviderLabel as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      const item = await graph.createItem(
        { title: 'Unknown provider' },
        { providerId: 'unknown', externalId: 'ext-1' },
      );
      const treeItem = providerWithResolver.getTreeItem(item);
      expect(treeItem.description).toBe('unknown');
    });
  });
});
