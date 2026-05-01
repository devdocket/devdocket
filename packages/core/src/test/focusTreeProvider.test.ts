import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter, DataTransfer, DataTransferItem, TreeItemCollapsibleState, window } from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { ActionRegistry } from '../services/actionRegistry';
import { FocusTreeProvider } from '../views/focusTreeProvider';

const DRAG_MIME_TYPE = 'application/vnd.code.tree.devdocket.focus';

function createMockWorkGraph() {
  const emitter = new EventEmitter<void>();
  return {
    onDidChange: emitter.event,
    getItemsByState: vi.fn((..._states: WorkItemState[]) => [] as WorkItem[]),
    getItem: vi.fn((_id: string) => undefined as WorkItem | undefined),
    reorderItem: vi.fn(async (_draggedId: string, _targetId: string) => {}),
    moveToEnd: vi.fn(async (_id: string) => {}),
    _fire: () => emitter.fire(),
  };
}

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'item-1',
    title: 'Test item',
    state: WorkItemState.InProgress,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function createMockAction(id: string, canRun: (item: WorkItem) => boolean = () => true) {
  return {
    id,
    label: `Action ${id}`,
    canRun: vi.fn(canRun),
    run: vi.fn(async () => {}),
  };
}

function createMockLinkStore(links: Array<{ itemId1: string; itemId2: string; relation: 'closes' | 'linked' }>) {
  const emitter = new EventEmitter<void>();
  return {
    getLinksForItem: vi.fn((itemId: string) => links.filter(link => link.itemId1 === itemId || link.itemId2 === itemId)),
    onDidChange: emitter.event,
    _fire: () => emitter.fire(),
  };
}

describe('FocusTreeProvider', () => {
  let workGraph: ReturnType<typeof createMockWorkGraph>;
  let provider: FocusTreeProvider;

  beforeEach(() => {
    workGraph = createMockWorkGraph();
    provider = new FocusTreeProvider(workGraph as any);
  });

  describe('getTreeItem contextValue', () => {
    it('should set contextValue to "active" for InProgress item without url', () => {
      const item = makeItem({ state: WorkItemState.InProgress });
      expect(provider.getTreeItem(item).contextValue).toBe('active');
    });

    it('should set contextValue to "active.hasUrl" for InProgress item with url', () => {
      const item = makeItem({ state: WorkItemState.InProgress, url: 'https://example.com' });
      expect(provider.getTreeItem(item).contextValue).toBe('active.hasUrl');
    });

    it('should set contextValue to "paused" for Paused item without url', () => {
      const item = makeItem({ state: WorkItemState.Paused });
      expect(provider.getTreeItem(item).contextValue).toBe('paused');
    });

    it('should set contextValue to "paused.hasUrl" for Paused item with url', () => {
      const item = makeItem({ state: WorkItemState.Paused, url: 'https://example.com' });
      expect(provider.getTreeItem(item).contextValue).toBe('paused.hasUrl');
    });

    it('should set contextValue to "active.hasUrl.watchable" when URL is watchable', () => {
      const watchableProvider = new FocusTreeProvider(workGraph as any, undefined, undefined, () => true);
      const item = makeItem({ state: WorkItemState.InProgress, url: 'https://github.com/owner/repo/pull/1' });
      expect(watchableProvider.getTreeItem(item).contextValue).toBe('active.hasUrl.watchable');
    });

    it('should set contextValue to "active.hasUrl" when URL is not watchable', () => {
      const unwatchableProvider = new FocusTreeProvider(workGraph as any, undefined, undefined, () => false);
      const item = makeItem({ state: WorkItemState.InProgress, url: 'https://example.com' });
      expect(unwatchableProvider.getTreeItem(item).contextValue).toBe('active.hasUrl');
    });

    it('should set contextValue to "paused.hasUrl.watchable" when paused URL is watchable', () => {
      const watchableProvider = new FocusTreeProvider(workGraph as any, undefined, undefined, () => true);
      const item = makeItem({ state: WorkItemState.Paused, url: 'https://github.com/owner/repo/pull/2' });
      expect(watchableProvider.getTreeItem(item).contextValue).toBe('paused.hasUrl.watchable');
    });

    it('should not append watchable when item has no URL even if isWatchable provided', () => {
      const watchableProvider = new FocusTreeProvider(workGraph as any, undefined, undefined, () => true);
      const item = makeItem({ state: WorkItemState.InProgress });
      expect(watchableProvider.getTreeItem(item).contextValue).toBe('active');
    });

    it('should set contextValue to "active.hasActions" when actions are available', () => {
      const actionRegistry = new ActionRegistry();
      actionRegistry.register(createMockAction('focus-action'));
      const actionableProvider = new FocusTreeProvider(workGraph as any, undefined, actionRegistry);
      const item = makeItem({ state: WorkItemState.InProgress });

      expect(actionableProvider.getTreeItem(item).contextValue).toBe('active.hasActions');
    });

    it('should append hasActions after watchable for paused items with actions', () => {
      const actionRegistry = new ActionRegistry();
      actionRegistry.register(createMockAction('paused-action'));
      const actionableProvider = new FocusTreeProvider(workGraph as any, undefined, actionRegistry, () => true);
      const item = makeItem({ state: WorkItemState.Paused, url: 'https://github.com/owner/repo/pull/2' });

      expect(actionableProvider.getTreeItem(item).contextValue).toBe('paused.hasUrl.watchable.hasActions');
    });

    it('should not append hasActions when canRun throws', () => {
      const actionRegistry = new ActionRegistry();
      actionRegistry.register(createMockAction('throwing', () => {
        throw new Error('boom');
      }));
      const actionableProvider = new FocusTreeProvider(workGraph as any, undefined, actionRegistry);
      const item = makeItem({ state: WorkItemState.InProgress });

      expect(actionableProvider.getTreeItem(item).contextValue).toBe('active');
    });

    it('should not append hasActions when no registered action can run', () => {
      const actionRegistry = new ActionRegistry();
      actionRegistry.register(createMockAction('paused-only', (item) => item.state === WorkItemState.Paused));
      const actionableProvider = new FocusTreeProvider(workGraph as any, undefined, actionRegistry);
      const item = makeItem({ state: WorkItemState.InProgress });

      expect(actionableProvider.getTreeItem(item).contextValue).toBe('active');
    });
  });

  describe('getTreeItem description', () => {
    it('should show undefined description for InProgress items without group', () => {
      const item = makeItem({ state: WorkItemState.InProgress });
      expect(provider.getTreeItem(item).description).toBeUndefined();
    });

    it('should show undefined description for Paused items without group', () => {
      const item = makeItem({ state: WorkItemState.Paused });
      expect(provider.getTreeItem(item).description).toBeUndefined();
    });

    it('should show group in flat layout when item has a group', () => {
      const item = makeItem({ state: WorkItemState.InProgress, group: 'octocat/repo' });
      expect(provider.getTreeItem(item).description).toBe('octocat/repo');
    });

    it('should show group in flat layout for paused item', () => {
      const item = makeItem({ state: WorkItemState.Paused, group: 'octocat/repo' });
      expect(provider.getTreeItem(item).description).toBe('octocat/repo');
    });

    it('should show undefined when group is undefined', () => {
      const item = makeItem({ state: WorkItemState.InProgress, group: undefined });
      expect(provider.getTreeItem(item).description).toBeUndefined();
    });

    it('should show undefined in tree layout', () => {
      provider.layout = 'tree';
      const item = makeItem({ state: WorkItemState.InProgress, group: 'octocat/repo' });
      expect(provider.getTreeItem(item).description).toBeUndefined();
    });

    it('should show group and provider label in flat layout with registry', () => {
      const emitter = new EventEmitter();
      const changeEmitter = new EventEmitter();
      const registry = {
        getProviderLabel: vi.fn((id: string) => id === 'github' ? 'GitHub Issues' : id),
        onDidRegisterProvider: emitter.event,
        onDidChangeDiscoveredItems: changeEmitter.event,
        getDiscoveredItems: vi.fn(() => []),
      };
      const focusWithRegistry = new FocusTreeProvider(workGraph as any, registry as any);
      const item = makeItem({ state: WorkItemState.InProgress, group: 'octocat/repo', providerId: 'github' });
      expect(focusWithRegistry.getTreeItem(item).description).toBe('octocat/repo · GitHub Issues');
    });
  });

  describe('getTreeItem icon', () => {
    it('should show play-circle icon for InProgress items', () => {
      const item = makeItem({ state: WorkItemState.InProgress });
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('play-circle');
    });

    it('should show debug-pause icon for Paused items', () => {
      const item = makeItem({ state: WorkItemState.Paused });
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('debug-pause');
    });
  });

  describe('getTreeItem tooltip', () => {
    it('should include title in tooltip', () => {
      const item = makeItem({ title: 'My Task' });
      const tooltip = (provider.getTreeItem(item).tooltip as any).value;
      expect(tooltip).toContain('My Task');
    });

    it('should include notes in tooltip when present', () => {
      const item = makeItem({ notes: 'Some details' });
      const tooltip = (provider.getTreeItem(item).tooltip as any).value;
      expect(tooltip).toContain('Some details');
    });

    it('should not include notes section when notes are absent', () => {
      const item = makeItem();
      const tooltip = (provider.getTreeItem(item).tooltip as any).value;
      expect(tooltip).not.toContain('**Notes:**');
    });

    it('should include state in tooltip', () => {
      const item = makeItem({ state: WorkItemState.Paused });
      const tooltip = (provider.getTreeItem(item).tooltip as any).value;
      expect(tooltip).toContain(WorkItemState.Paused);
    });

    it('should include created timestamp in tooltip', () => {
      const ts = 1700000000000;
      const item = makeItem({ createdAt: ts });
      const tooltip = (provider.getTreeItem(item).tooltip as any).value;
      expect(tooltip).toContain('**Created:**');
      expect(tooltip).toContain(new Date(ts).toLocaleString());
    });
  });

  describe('getChildren', () => {
    it('should return items sorted by state priority then sortOrder', () => {
      const items = [
        makeItem({ id: '1', title: 'Paused-0', state: WorkItemState.Paused, sortOrder: 0 }),
        makeItem({ id: '2', title: 'Active-0', state: WorkItemState.InProgress, sortOrder: 0 }),
        makeItem({ id: '3', title: 'Active-1', state: WorkItemState.InProgress, sortOrder: 1 }),
        makeItem({ id: '4', title: 'Paused-1', state: WorkItemState.Paused, sortOrder: 1 }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);

      const children = provider.getChildren();
      expect(children.map(c => c.title)).toEqual([
        'Active-0', 'Active-1', 'Paused-0', 'Paused-1',
      ]);
    });

    it('should sort items without sortOrder after those with sortOrder within the same state', () => {
      const items = [
        makeItem({ id: '1', title: 'Active-no-order', state: WorkItemState.InProgress }),
        makeItem({ id: '2', title: 'Active-ordered', state: WorkItemState.InProgress, sortOrder: 0 }),
        makeItem({ id: '3', title: 'Paused-ordered', state: WorkItemState.Paused, sortOrder: 0 }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);

      const children = provider.getChildren();
      expect(children.map(c => c.title)).toEqual([
        'Active-ordered', 'Active-no-order', 'Paused-ordered',
      ]);
    });

    it('should request InProgress and Paused states', () => {
      workGraph.getItemsByState.mockReturnValue([]);
      provider.getChildren();
      expect(workGraph.getItemsByState).toHaveBeenCalledWith(
        WorkItemState.InProgress,
        WorkItemState.Paused,
      );
    });

    it('should return empty array when no focus items exist', () => {
      workGraph.getItemsByState.mockReturnValue([]);
      expect(provider.getChildren()).toEqual([]);
    });

    it('nests linked focus items beneath their parent item', () => {
      const parent = makeItem({ id: 'parent', title: 'Parent focus', externalId: 'owner/repo#42' });
      const child = makeItem({ id: 'child', title: 'Child focus', externalId: 'owner/repo#7' });
      const itemMap = new Map([[parent.id, parent], [child.id, child]]);
      workGraph.getItemsByState.mockReturnValue([parent, child]);
      workGraph.getItem.mockImplementation((id: string) => itemMap.get(id));
      const linkStore = createMockLinkStore([{ itemId1: parent.id, itemId2: child.id, relation: 'closes' }]);
      const linkedProvider = new FocusTreeProvider(workGraph as any, undefined, undefined, undefined, linkStore as any);

      const linkedChildren = linkedProvider.getChildren(parent) as WorkItem[];
      expect(linkedChildren).toHaveLength(1);
      expect(linkedChildren[0].id).toBe(child.id);
      expect(linkedProvider.getTreeItem(parent).collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect(linkedProvider.getTreeItem(linkedChildren[0]).description).toBe('Closes #42');
    });
  });

  describe('handleDrag', () => {
    it('serializes dragged item ids into data transfer', () => {
      const item = makeItem({ id: 'drag-1' });
      const dataTransfer = new DataTransfer();

      provider.handleDrag([item], dataTransfer);

      const transferItem = dataTransfer.get(DRAG_MIME_TYPE);
      expect(transferItem).toBeDefined();
      expect(transferItem!.value).toEqual(['drag-1']);
    });

    it('serializes multiple dragged item ids', () => {
      const a = makeItem({ id: 'a' });
      const b = makeItem({ id: 'b' });
      const dataTransfer = new DataTransfer();

      provider.handleDrag([a, b], dataTransfer);

      const transferItem = dataTransfer.get(DRAG_MIME_TYPE);
      expect(transferItem!.value).toEqual(['a', 'b']);
    });

    it('uses the correct MIME type', () => {
      const item = makeItem({ id: 'mime-check' });
      const dataTransfer = new DataTransfer();

      provider.handleDrag([item], dataTransfer);

      expect(dataTransfer.get(DRAG_MIME_TYPE)).toBeDefined();
      expect(dataTransfer.get('text/plain')).toBeUndefined();
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

    it('shows live title from provider for provider-backed items', () => {
      const discovered = new Map([
        ['github', [{ externalId: 'ext-1', title: 'Live Focus Title' }]],
      ]);
      const registry = createMockProviderRegistry(discovered);
      const providerWithRegistry = new FocusTreeProvider(workGraph as any, registry as any);

      const item = makeItem({
        id: 'p1',
        title: 'Persisted Title',
        providerId: 'github',
        externalId: 'ext-1',
        state: WorkItemState.InProgress,
      });

      const treeItem = providerWithRegistry.getTreeItem(item);
      expect(treeItem.label).toBe('Live Focus Title');
    });

    it('shows persisted title for items without a provider', () => {
      const registry = createMockProviderRegistry();
      const providerWithRegistry = new FocusTreeProvider(workGraph as any, registry as any);

      const item = makeItem({ id: 'manual-1', title: 'Manual Focus Item' });

      const treeItem = providerWithRegistry.getTreeItem(item);
      expect(treeItem.label).toBe('Manual Focus Item');
    });

    it('falls back to persisted title when discovered item does not exist', () => {
      const discovered = new Map([
        ['github', [{ externalId: 'other-id', title: 'Wrong Item' }]],
      ]);
      const registry = createMockProviderRegistry(discovered);
      const providerWithRegistry = new FocusTreeProvider(workGraph as any, registry as any);

      const item = makeItem({
        id: 'p2',
        title: 'Persisted Fallback',
        providerId: 'github',
        externalId: 'ext-missing',
        state: WorkItemState.InProgress,
      });

      const treeItem = providerWithRegistry.getTreeItem(item);
      expect(treeItem.label).toBe('Persisted Fallback');
    });

    it('uses persisted title when no providerRegistry is provided', () => {
      // provider (from beforeEach) has no registry
      const item = makeItem({
        id: 'p3',
        title: 'No Registry Title',
        providerId: 'github',
        externalId: 'ext-1',
        state: WorkItemState.InProgress,
      });

      const treeItem = provider.getTreeItem(item);
      expect(treeItem.label).toBe('No Registry Title');
    });

    it('includes resolved title in tooltip', () => {
      const discovered = new Map([
        ['github', [{ externalId: 'ext-1', title: 'Live Tooltip Title' }]],
      ]);
      const registry = createMockProviderRegistry(discovered);
      const providerWithRegistry = new FocusTreeProvider(workGraph as any, registry as any);

      const item = makeItem({
        id: 'p4',
        title: 'Persisted Title',
        providerId: 'github',
        externalId: 'ext-1',
        state: WorkItemState.InProgress,
      });

      const treeItem = providerWithRegistry.getTreeItem(item);
      const tooltip = (treeItem.tooltip as any).value;
      expect(tooltip).toContain('Live Tooltip Title');
      expect(tooltip).not.toContain('Persisted Title');
    });

    it('refreshes tree when discovered items change', () => {
      const registry = createMockProviderRegistry();
      const providerWithRegistry = new FocusTreeProvider(workGraph as any, registry as any);

      const listener = vi.fn();
      providerWithRegistry.onDidChangeTreeData(listener);

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

  describe('handleDrop', () => {
    beforeEach(() => {
      (window.showInformationMessage as ReturnType<typeof vi.fn>).mockClear();
    });

    it('should reject drop when dragged item and target have different states', async () => {
      const inProgressItem = makeItem({ id: 'a', state: WorkItemState.InProgress });
      const pausedItem = makeItem({ id: 'b', state: WorkItemState.Paused });
      workGraph.getItem.mockReturnValue(inProgressItem);

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem(['a']));

      await provider.handleDrop(pausedItem, dataTransfer);

      expect(workGraph.reorderItem).not.toHaveBeenCalled();
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        'DevDocket: Cannot reorder items across different states.'
      );
    });

    it('should allow drop when dragged item and target have same state', async () => {
      const item1 = makeItem({ id: 'a', state: WorkItemState.InProgress });
      const item2 = makeItem({ id: 'b', state: WorkItemState.InProgress });
      workGraph.getItem.mockReturnValue(item1);

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem(['a']));

      await provider.handleDrop(item2, dataTransfer);

      expect(workGraph.reorderItem).toHaveBeenCalledWith('a', 'b');
    });

    it('should call moveToEnd when target is undefined', async () => {
      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem(['a']));

      await provider.handleDrop(undefined, dataTransfer);

      expect(workGraph.moveToEnd).toHaveBeenCalledWith('a');
    });

    it('should no-op when dragged item is not found', async () => {
      const target = makeItem({ id: 'b', state: WorkItemState.InProgress });
      workGraph.getItem.mockReturnValue(undefined);

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem(['a']));

      await provider.handleDrop(target, dataTransfer);

      expect(workGraph.reorderItem).not.toHaveBeenCalled();
    });

    it('should no-op when no transfer item exists', async () => {
      const target = makeItem({ id: 'a', state: WorkItemState.InProgress });
      const dataTransfer = new DataTransfer();

      await provider.handleDrop(target, dataTransfer);

      expect(workGraph.reorderItem).not.toHaveBeenCalled();
      expect(workGraph.moveToEnd).not.toHaveBeenCalled();
    });

    it('should no-op when transfer value is not an array', async () => {
      const target = makeItem({ id: 'a', state: WorkItemState.InProgress });
      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem('not-an-array'));

      await provider.handleDrop(target, dataTransfer);

      expect(workGraph.reorderItem).not.toHaveBeenCalled();
      expect(workGraph.moveToEnd).not.toHaveBeenCalled();
    });

    it('should no-op when transfer value contains non-string', async () => {
      const target = makeItem({ id: 'a', state: WorkItemState.InProgress });
      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem([123]));

      await provider.handleDrop(target, dataTransfer);

      expect(workGraph.reorderItem).not.toHaveBeenCalled();
      expect(workGraph.moveToEnd).not.toHaveBeenCalled();
    });

    it('should no-op when dragging multiple items', async () => {
      const target = makeItem({ id: 'c', state: WorkItemState.InProgress });
      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem(['a', 'b']));

      await provider.handleDrop(target, dataTransfer);

      expect(workGraph.reorderItem).not.toHaveBeenCalled();
      expect(workGraph.moveToEnd).not.toHaveBeenCalled();
    });
  });

  describe('events', () => {
    it('should refresh when workGraph fires change event', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      workGraph._fire();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should refresh when action registrations change', () => {
      const actionRegistry = new ActionRegistry();
      const actionableProvider = new FocusTreeProvider(workGraph as any, undefined, actionRegistry);
      const listener = vi.fn();
      actionableProvider.onDidChangeTreeData(listener);

      const registration = actionRegistry.register(createMockAction('focus-refresh'));
      expect(listener).toHaveBeenCalledTimes(1);

      registration.dispose();
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  describe('dispose', () => {
    it('should stop firing events after dispose', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      provider.dispose();
      workGraph._fire();
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
