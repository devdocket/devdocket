import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter, DataTransfer, DataTransferItem, window } from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { FocusTreeProvider } from '../views/focusTreeProvider';

const DRAG_MIME_TYPE = 'application/vnd.code.tree.workcenter.focus';

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
  });

  describe('getTreeItem description', () => {
    it('should show "in progress" for InProgress items', () => {
      const item = makeItem({ state: WorkItemState.InProgress });
      expect(provider.getTreeItem(item).description).toBe('in progress');
    });

    it('should show "⏸ paused" for Paused items', () => {
      const item = makeItem({ state: WorkItemState.Paused });
      expect(provider.getTreeItem(item).description).toBe('⏸ paused');
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
  });

  describe('handleDrop', () => {
    it('should reject drop when dragged item and target have different states', async () => {
      const inProgressItem = makeItem({ id: 'a', state: WorkItemState.InProgress });
      const pausedItem = makeItem({ id: 'b', state: WorkItemState.Paused });
      workGraph.getItem.mockReturnValue(inProgressItem);

      const dataTransfer = new DataTransfer();
      dataTransfer.set(DRAG_MIME_TYPE, new DataTransferItem(['a']));

      await provider.handleDrop(pausedItem, dataTransfer);

      expect(workGraph.reorderItem).not.toHaveBeenCalled();
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        'WorkCenter: Cannot reorder items across different states.'
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
  });

  describe('events', () => {
    it('should refresh when workGraph fires change event', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      workGraph._fire();
      expect(listener).toHaveBeenCalledTimes(1);
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
