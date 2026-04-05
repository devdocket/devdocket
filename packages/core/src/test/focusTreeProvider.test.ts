import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { FocusTreeProvider } from '../views/focusTreeProvider';

function createMockWorkGraph() {
  const emitter = new EventEmitter<void>();
  return {
    onDidChange: emitter.event,
    getItemsByState: vi.fn((..._states: WorkItemState[]) => [] as WorkItem[]),
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

    it('should set contextValue to "blocked" for Blocked item without url', () => {
      const item = makeItem({ state: WorkItemState.Blocked });
      expect(provider.getTreeItem(item).contextValue).toBe('blocked');
    });

    it('should set contextValue to "blocked.hasUrl" for Blocked item with url', () => {
      const item = makeItem({ state: WorkItemState.Blocked, url: 'https://example.com' });
      expect(provider.getTreeItem(item).contextValue).toBe('blocked.hasUrl');
    });

    it('should set contextValue to "blocked.hasUrl" for WaitingOn item with url', () => {
      const item = makeItem({ state: WorkItemState.WaitingOn, url: 'https://example.com' });
      expect(provider.getTreeItem(item).contextValue).toBe('blocked.hasUrl');
    });

    it('should set contextValue to "blocked" for WaitingOn item without url', () => {
      const item = makeItem({ state: WorkItemState.WaitingOn });
      expect(provider.getTreeItem(item).contextValue).toBe('blocked');
    });
  });

  describe('getTreeItem description', () => {
    it('should show "in progress" for InProgress items', () => {
      const item = makeItem({ state: WorkItemState.InProgress });
      expect(provider.getTreeItem(item).description).toBe('in progress');
    });

    it('should show "⛔ blocked" for Blocked items', () => {
      const item = makeItem({ state: WorkItemState.Blocked });
      expect(provider.getTreeItem(item).description).toBe('⛔ blocked');
    });

    it('should show "⏳ waiting" for WaitingOn items', () => {
      const item = makeItem({ state: WorkItemState.WaitingOn });
      expect(provider.getTreeItem(item).description).toBe('⏳ waiting');
    });
  });

  describe('getTreeItem icon', () => {
    it('should show play-circle icon for InProgress items', () => {
      const item = makeItem({ state: WorkItemState.InProgress });
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('play-circle');
    });

    it('should show circle-slash icon for Blocked items', () => {
      const item = makeItem({ state: WorkItemState.Blocked });
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('circle-slash');
    });

    it('should show clock icon for WaitingOn items', () => {
      const item = makeItem({ state: WorkItemState.WaitingOn });
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('clock');
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
      const item = makeItem({ state: WorkItemState.Blocked });
      const tooltip = (provider.getTreeItem(item).tooltip as any).value;
      expect(tooltip).toContain(WorkItemState.Blocked);
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
    it('should return items sorted by title', () => {
      const items = [
        makeItem({ id: '2', title: 'Zebra', state: WorkItemState.InProgress }),
        makeItem({ id: '1', title: 'Alpha', state: WorkItemState.Blocked }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);

      const children = provider.getChildren();
      expect(children.map(c => c.title)).toEqual(['Alpha', 'Zebra']);
    });

    it('should request InProgress, Blocked, and WaitingOn states', () => {
      workGraph.getItemsByState.mockReturnValue([]);
      provider.getChildren();
      expect(workGraph.getItemsByState).toHaveBeenCalledWith(
        WorkItemState.InProgress,
        WorkItemState.Blocked,
        WorkItemState.WaitingOn,
      );
    });

    it('should return empty array when no focus items exist', () => {
      workGraph.getItemsByState.mockReturnValue([]);
      expect(provider.getChildren()).toEqual([]);
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
