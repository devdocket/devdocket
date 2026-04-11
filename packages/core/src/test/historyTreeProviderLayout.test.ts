import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter, TreeItemCollapsibleState } from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { HistoryTreeProvider } from '../views/historyTreeProvider';
import { isProviderGroupNode, ProviderGroupNode } from '../views/viewLayout';

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

describe('HistoryTreeProvider layout toggle', () => {
  let workGraph: ReturnType<typeof createMockWorkGraph>;
  let provider: HistoryTreeProvider;

  beforeEach(() => {
    workGraph = createMockWorkGraph();
    provider = new HistoryTreeProvider(workGraph as any);
  });

  it('defaults to flat layout', () => {
    expect(provider.layout).toBe('flat');
  });

  it('fires tree data change when layout changes', () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.layout = 'tree';
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire when setting same layout', () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.layout = 'flat';
    expect(listener).not.toHaveBeenCalled();
  });

  describe('flat mode (default)', () => {
    it('returns work items directly', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'Done item', state: WorkItemState.Done }),
        makeItem({ id: '2', title: 'Archived item', state: WorkItemState.Archived }),
      ]);
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every(c => !isProviderGroupNode(c))).toBe(true);
    });
  });

  describe('tree mode', () => {
    beforeEach(() => {
      provider.layout = 'tree';
    });

    it('returns provider group nodes at top level', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'A', state: WorkItemState.Done, providerId: 'github' }),
        makeItem({ id: '2', title: 'B', state: WorkItemState.Done, providerId: 'jira' }),
      ]);
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every(c => isProviderGroupNode(c))).toBe(true);
    });

    it('groups items without providerId under "Other"', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'Manual', state: WorkItemState.Done }),
        makeItem({ id: '2', title: 'Provider', state: WorkItemState.Done, providerId: 'github' }),
      ]);
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      const labels = children.map(c => (c as ProviderGroupNode).label);
      expect(labels).toContain('Other');
      expect(labels).toContain('github');
    });

    it('sorts "Other" group last', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'Manual', state: WorkItemState.Done }),
        makeItem({ id: '2', title: 'Provider', state: WorkItemState.Done, providerId: 'alpha' }),
      ]);
      const children = provider.getChildren();
      expect((children[children.length - 1] as ProviderGroupNode).label).toBe('Other');
    });

    it('returns items for a provider group', () => {
      workGraph._setItems([
        makeItem({ id: '1', title: 'A', state: WorkItemState.Done, providerId: 'github' }),
        makeItem({ id: '2', title: 'B', state: WorkItemState.Archived, providerId: 'github' }),
        makeItem({ id: '3', title: 'C', state: WorkItemState.Done, providerId: 'jira' }),
      ]);
      const group: ProviderGroupNode = { kind: 'providerGroup', label: 'github', providerId: 'github' };
      const children = provider.getChildren(group);
      expect(children).toHaveLength(2);
      expect(children.every(c => !isProviderGroupNode(c))).toBe(true);
    });

    it('renders group node as collapsed tree item', () => {
      const group: ProviderGroupNode = { kind: 'providerGroup', label: 'github', providerId: 'github' };
      const treeItem = provider.getTreeItem(group);
      expect(treeItem.label).toBe('github');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect(treeItem.contextValue).toBe('historyGroup');
    });

    it('returns empty for item node children', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.Done });
      expect(provider.getChildren(item)).toEqual([]);
    });
  });
});
