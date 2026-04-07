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
    createdAt: Date.now(),
    updatedAt: Date.now(),
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

    it('should set contextValue to "blocked" for Blocked item without url', () => {
      const item = makeItem({ state: WorkItemState.Blocked });
      expect(provider.getTreeItem(item).contextValue).toBe('blocked');
    });

    it('should set contextValue to "blocked.hasUrl" for Blocked item with url', () => {
      const item = makeItem({ state: WorkItemState.Blocked, url: 'https://example.com' });
      expect(provider.getTreeItem(item).contextValue).toBe('blocked.hasUrl');
    });

    it('should set contextValue to "waitingOn" for WaitingOn item without url', () => {
      const item = makeItem({ state: WorkItemState.WaitingOn });
      expect(provider.getTreeItem(item).contextValue).toBe('waitingOn');
    });

    it('should set contextValue to "waitingOn.hasUrl" for WaitingOn item with url', () => {
      const item = makeItem({ state: WorkItemState.WaitingOn, url: 'https://example.com' });
      expect(provider.getTreeItem(item).contextValue).toBe('waitingOn.hasUrl');
    });
  });

  describe('getTreeItem description and icon', () => {
    it('should show "🚫 blocked" description for Blocked item', () => {
      const item = makeItem({ state: WorkItemState.Blocked });
      expect(provider.getTreeItem(item).description).toBe('🚫 blocked');
    });

    it('should show "⏳ waiting" description for WaitingOn item', () => {
      const item = makeItem({ state: WorkItemState.WaitingOn });
      expect(provider.getTreeItem(item).description).toBe('⏳ waiting');
    });

    it('should use error icon for Blocked item', () => {
      const item = makeItem({ state: WorkItemState.Blocked });
      const icon = provider.getTreeItem(item).iconPath as any;
      expect(icon.id).toBe('error');
    });

    it('should use watch icon for WaitingOn item', () => {
      const item = makeItem({ state: WorkItemState.WaitingOn });
      const icon = provider.getTreeItem(item).iconPath as any;
      expect(icon.id).toBe('watch');
    });
  });

  describe('getChildren', () => {
    it('should return items sorted by title', () => {
      const items = [
        makeItem({ id: '2', title: 'Zebra', state: WorkItemState.InProgress }),
        makeItem({ id: '1', title: 'Alpha', state: WorkItemState.Paused }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);

      const children = provider.getChildren();
      expect(children.map(c => c.title)).toEqual(['Alpha', 'Zebra']);
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
});
