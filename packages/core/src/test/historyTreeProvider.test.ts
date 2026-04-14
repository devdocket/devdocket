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

    it('should return empty when items exist but none are Done or Archived', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'In progress', state: WorkItemState.InProgress }),
        makeItem({ id: '2', title: 'New', state: WorkItemState.New }),
        makeItem({ id: '3', title: 'Paused', state: WorkItemState.Paused }),
      ]);
      expect(provider.getChildren()).toEqual([]);
    });

    it('should return only Done items when no Archived items exist', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'Done A', state: WorkItemState.Done, updatedAt: 1000 }),
        makeItem({ id: '2', title: 'Done B', state: WorkItemState.Done, updatedAt: 2000 }),
        makeItem({ id: '3', title: 'In progress', state: WorkItemState.InProgress }),
      ]);

      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every(c => c.state === WorkItemState.Done)).toBe(true);
    });

    it('should return only Archived items when no Done items exist', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'Archived A', state: WorkItemState.Archived, updatedAt: 1000 }),
        makeItem({ id: '2', title: 'Archived B', state: WorkItemState.Archived, updatedAt: 2000 }),
        makeItem({ id: '3', title: 'New', state: WorkItemState.New }),
      ]);

      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every(c => c.state === WorkItemState.Archived)).toBe(true);
    });

    it('should return both Done and Archived items together', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'Done item', state: WorkItemState.Done, updatedAt: 2000 }),
        makeItem({ id: '2', title: 'Archived item', state: WorkItemState.Archived, updatedAt: 1000 }),
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

    it('should sort mixed Done and Archived by updatedAt regardless of state', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'Done old', state: WorkItemState.Done, updatedAt: 100 }),
        makeItem({ id: '2', title: 'Archived recent', state: WorkItemState.Archived, updatedAt: 300 }),
        makeItem({ id: '3', title: 'Done recent', state: WorkItemState.Done, updatedAt: 200 }),
      ]);

      const children = provider.getChildren();
      expect(children.map(c => c.title)).toEqual(['Archived recent', 'Done recent', 'Done old']);
    });

    it('should handle single Done item', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'Solo done', state: WorkItemState.Done }),
      ]);

      const children = provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0].title).toBe('Solo done');
    });

    it('should handle single Archived item', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'Solo archived', state: WorkItemState.Archived }),
      ]);

      const children = provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0].title).toBe('Solo archived');
    });

    it('should handle many items and maintain sort order', () => {
      const items = Array.from({ length: 20 }, (_, i) =>
        makeItem({
          id: `item-${i}`,
          title: `Item ${i}`,
          state: i % 2 === 0 ? WorkItemState.Done : WorkItemState.Archived,
          updatedAt: i * 100,
        }),
      );
      workGraph._setItems(items);

      const children = provider.getChildren();
      expect(children).toHaveLength(20);
      // Most recent first: item-19 (updatedAt=1900) down to item-0 (updatedAt=0)
      for (let i = 0; i < children.length - 1; i++) {
        expect(children[i].updatedAt).toBeGreaterThanOrEqual(children[i + 1].updatedAt);
      }
    });

    it('should handle items with equal updatedAt timestamps', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'A', state: WorkItemState.Done, updatedAt: 5000 }),
        makeItem({ id: '2', title: 'B', state: WorkItemState.Archived, updatedAt: 5000 }),
      ]);

      const children = provider.getChildren();
      expect(children).toHaveLength(2);
    });

    it('should pass Done and Archived states to getItemsByState', () => {
      provider.getChildren();
      expect(workGraph.getItemsByState).toHaveBeenCalledWith(
        WorkItemState.Done,
        WorkItemState.Archived,
      );
    });
  });

  describe('getTreeItem', () => {
    it('should render Done item with check icon and done label', () => {
      const item = makeItem({ id: '1', title: 'Completed task', state: WorkItemState.Done });
      const treeItem = provider.getTreeItem(item);

      expect(treeItem.label).toBe('Completed task');
      expect(treeItem.description).toBe('done');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect((treeItem.iconPath as any).id).toBe('check');
    });

    it('should render Archived item with archive icon and archived label', () => {
      const item = makeItem({ id: '1', title: 'Old task', state: WorkItemState.Archived });
      const treeItem = provider.getTreeItem(item);

      expect(treeItem.label).toBe('Old task');
      expect(treeItem.description).toBe('archived');
      expect((treeItem.iconPath as any).id).toBe('archive');
    });

    it('should use circle-outline icon for unexpected state', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.InProgress });
      const treeItem = provider.getTreeItem(item);
      expect((treeItem.iconPath as any).id).toBe('circle-outline');
    });

    it('should use raw state string as description for unexpected state', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.InProgress });
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.description).toBe('InProgress');
    });

    it('should always set collapsibleState to None (flat list)', () => {
      const doneItem = makeItem({ id: '1', title: 'A', state: WorkItemState.Done });
      const archivedItem = makeItem({ id: '2', title: 'B', state: WorkItemState.Archived });

      expect(provider.getTreeItem(doneItem).collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect(provider.getTreeItem(archivedItem).collapsibleState).toBe(TreeItemCollapsibleState.None);
    });
  });

  describe('contextValue', () => {
    it('should set contextValue to historyItem.done.hasUrl for Done item with url', () => {
      const item = makeItem({ id: '1', title: 'X', url: 'https://example.com', state: WorkItemState.Done });
      expect(provider.getTreeItem(item).contextValue).toBe('historyItem.done.hasUrl');
    });

    it('should set contextValue to historyItem.done for Done item without url', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Done });
      expect(provider.getTreeItem(item).contextValue).toBe('historyItem.done');
    });

    it('should set contextValue to historyItem.archived.hasUrl for Archived item with url', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Archived, url: 'https://github.com/issue/1' });
      expect(provider.getTreeItem(item).contextValue).toBe('historyItem.archived.hasUrl');
    });

    it('should set contextValue to historyItem.archived for Archived item without url', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Archived });
      expect(provider.getTreeItem(item).contextValue).toBe('historyItem.archived');
    });

    it('should set contextValue to historyItem.done when url is undefined', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Done, url: undefined });
      expect(provider.getTreeItem(item).contextValue).toBe('historyItem.done');
    });

    it('should fall back to historyItem for unexpected states', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.InProgress });
      expect(provider.getTreeItem(item).contextValue).toBe('historyItem');
    });

    it('should fall back to historyItem.hasUrl for unexpected states with url', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.InProgress, url: 'https://example.com' });
      expect(provider.getTreeItem(item).contextValue).toBe('historyItem.hasUrl');
    });
  });

  describe('tooltip', () => {
    it('should include title in tooltip', () => {
      const item = makeItem({ id: '1', title: 'My Task' });
      const tooltip = provider.getTreeItem(item).tooltip as any;
      expect(tooltip.value).toContain('My Task');
    });

    it('should include notes in tooltip when present', () => {
      const item = makeItem({ id: '1', title: 'Task', notes: 'Important details' });
      const tooltip = provider.getTreeItem(item).tooltip as any;
      expect(tooltip.value).toContain('Important details');
      expect(tooltip.value).toContain('Notes');
    });

    it('should not include notes section in tooltip when notes are absent', () => {
      const item = makeItem({ id: '1', title: 'Task' });
      const tooltip = provider.getTreeItem(item).tooltip as any;
      expect(tooltip.value).not.toContain('Notes');
    });

    it('should include state in tooltip', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Done });
      const tooltip = provider.getTreeItem(item).tooltip as any;
      expect(tooltip.value).toContain('Done');
    });

    it('should show "Completed at" label for Done items', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Done });
      const tooltip = provider.getTreeItem(item).tooltip as any;
      expect(tooltip.value).toContain('Completed at');
    });

    it('should show "Archived at" label for Archived items', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Archived });
      const tooltip = provider.getTreeItem(item).tooltip as any;
      expect(tooltip.value).toContain('Archived at');
    });

    it('should show "Last updated" label for other states', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.InProgress });
      const tooltip = provider.getTreeItem(item).tooltip as any;
      expect(tooltip.value).toContain('Last updated');
    });

    it('should include formatted timestamp in tooltip', () => {
      const ts = 1700000000000;
      const item = makeItem({ id: '1', title: 'X', updatedAt: ts });
      const tooltip = provider.getTreeItem(item).tooltip as any;
      expect(tooltip.value).toContain(new Date(ts).toLocaleString());
    });

    it('should include title in tooltip', () => {
      const item = makeItem({ id: '1', title: 'My History Item' });
      const tooltip = (provider.getTreeItem(item).tooltip as any).value;
      expect(tooltip).toContain('My History Item');
    });

    it('should not include notes section when notes are absent', () => {
      const item = makeItem({ id: '1', title: 'X' });
      const tooltip = (provider.getTreeItem(item).tooltip as any).value;
      expect(tooltip).not.toContain('**Notes:**');
    });

    it('should include state in tooltip', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Archived });
      const tooltip = (provider.getTreeItem(item).tooltip as any).value;
      expect(tooltip).toContain(WorkItemState.Archived);
    });

    it('should show "Completed at" timestamp label for Done items', () => {
      const ts = 1700000000000;
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Done, updatedAt: ts });
      const tooltip = (provider.getTreeItem(item).tooltip as any).value;
      expect(tooltip).toContain('**Completed at:**');
      expect(tooltip).toContain(new Date(ts).toLocaleString());
    });

    it('should show "Archived at" timestamp label for Archived items', () => {
      const ts = 1700000000000;
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Archived, updatedAt: ts });
      const tooltip = (provider.getTreeItem(item).tooltip as any).value;
      expect(tooltip).toContain('**Archived at:**');
      expect(tooltip).toContain(new Date(ts).toLocaleString());
    });
  });

  describe('events', () => {
    it('should fire onDidChangeTreeData when workGraph changes', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      workGraph._fire();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should fire onDidChangeTreeData on each workGraph change', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      workGraph._fire();
      workGraph._fire();
      workGraph._fire();
      expect(listener).toHaveBeenCalledTimes(3);
    });

    it('should fire onDidChangeTreeData when refresh is called', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      provider.refresh();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('dispose', () => {
    it('should not throw on dispose', () => {
      expect(() => provider.dispose()).not.toThrow();
    });

    it('should stop forwarding workGraph events after dispose', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      provider.dispose();
      workGraph._fire();
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
