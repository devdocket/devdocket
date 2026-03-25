import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter, TreeItemCollapsibleState } from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { HistoryTreeProvider } from '../views/historyTreeProvider';

function createMockWorkGraph(items: WorkItem[] = []) {
  const emitter = new EventEmitter<void>();
  return {
    getItemsByState: vi.fn((...states: WorkItemState[]) =>
      items.filter(i => states.includes(i.state)),
    ),
    onDidChange: emitter.event,
    _fire: () => emitter.fire(),
    _setItems: (newItems: WorkItem[]) => { items = newItems; },
  };
}

function makeItem(overrides: Partial<WorkItem> & { id: string; title: string }): WorkItem {
  return {
    state: WorkItemState.Done,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('HistoryTreeProvider', () => {
  let workGraph: ReturnType<typeof createMockWorkGraph>;
  let provider: HistoryTreeProvider;

  beforeEach(() => {
    workGraph = createMockWorkGraph();
    provider = new HistoryTreeProvider(workGraph as any);
  });

  describe('getChildren', () => {
    it('should return empty when no done or archived items exist', () => {
      expect(provider.getChildren()).toEqual([]);
    });

    it('should return only Done and Archived items', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'Done item', state: WorkItemState.Done }),
        makeItem({ id: '2', title: 'Archived item', state: WorkItemState.Archived }),
        makeItem({ id: '3', title: 'In progress', state: WorkItemState.InProgress }),
        makeItem({ id: '4', title: 'New', state: WorkItemState.New }),
      ]);

      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.map(c => c.title)).toContain('Done item');
      expect(children.map(c => c.title)).toContain('Archived item');
    });

    it('should sort by updatedAt descending (most recent first)', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'Older', state: WorkItemState.Done, updatedAt: 1000 }),
        makeItem({ id: '2', title: 'Newer', state: WorkItemState.Done, updatedAt: 3000 }),
        makeItem({ id: '3', title: 'Middle', state: WorkItemState.Archived, updatedAt: 2000 }),
      ]);

      const children = provider.getChildren();
      expect(children.map(c => c.title)).toEqual(['Newer', 'Middle', 'Older']);
    });
  });

  describe('getTreeItem', () => {
    it('should render Done item with check icon and done label', () => {
      const item = makeItem({ id: '1', title: 'Completed task', state: WorkItemState.Done });
      const treeItem = provider.getTreeItem(item);

      expect(treeItem.label).toBe('Completed task');
      expect(treeItem.description).toBe('✓ done');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect((treeItem.iconPath as any).id).toBe('check');
    });

    it('should render Archived item with archive icon and archived label', () => {
      const item = makeItem({ id: '1', title: 'Old task', state: WorkItemState.Archived });
      const treeItem = provider.getTreeItem(item);

      expect(treeItem.description).toBe('📦 archived');
      expect((treeItem.iconPath as any).id).toBe('archive');
    });

    it('should set contextValue with hasUrl when item has url', () => {
      const item = makeItem({ id: '1', title: 'X', url: 'https://example.com', state: WorkItemState.Done });
      expect(provider.getTreeItem(item).contextValue).toBe('historyItem.hasUrl');
    });

    it('should set contextValue without hasUrl when item lacks url', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Done });
      expect(provider.getTreeItem(item).contextValue).toBe('historyItem');
    });

    it('should set same contextValue for Archived item without url', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Archived });
      expect(provider.getTreeItem(item).contextValue).toBe('historyItem');
    });

    it('should set same contextValue with hasUrl for Archived item with url', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Archived, url: 'https://example.com' });
      expect(provider.getTreeItem(item).contextValue).toBe('historyItem.hasUrl');
    });

    it('should include description in tooltip when present', () => {
      const item = makeItem({ id: '1', title: 'Task', description: 'Details here' });
      const treeItem = provider.getTreeItem(item);
      expect((treeItem.tooltip as any).value).toContain('Details here');
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
    it('should not throw on dispose', () => {
      expect(() => provider.dispose()).not.toThrow();
    });
  });
});
