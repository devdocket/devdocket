import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter, TreeItemCollapsibleState } from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { FocusTreeProvider } from '../views/focusTreeProvider';
import { isSubGroupNode, SubGroupNode } from '../views/viewLayout';

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

function createMockProviderRegistry(labels: Record<string, string> = {}) {
  return {
    getProviderLabel: vi.fn((id: string) => labels[id] ?? id),
  };
}

describe('FocusTreeProvider layout toggle', () => {
  let workGraph: ReturnType<typeof createMockWorkGraph>;
  let provider: FocusTreeProvider;
  const providerLabels: Record<string, string> = { github: 'GitHub', jira: 'Jira' };

  beforeEach(() => {
    workGraph = createMockWorkGraph();
    provider = new FocusTreeProvider(workGraph as any, createMockProviderRegistry(providerLabels) as any);
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

  describe('tree mode', () => {
    beforeEach(() => {
      provider.layout = 'tree';
    });

    it('returns group nodes by item.group at top level', () => {
      const items = [
        makeItem({ id: '1', title: 'A', providerId: 'github', state: WorkItemState.InProgress, group: 'contoso/webapp' }),
        makeItem({ id: '2', title: 'B', providerId: 'jira', state: WorkItemState.Paused, group: 'myorg/api' }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every(c => isSubGroupNode(c))).toBe(true);
      const labels = children.map(c => (c as SubGroupNode).label);
      expect(labels).toContain('contoso/webapp');
      expect(labels).toContain('myorg/api');
    });

    it('shows ungrouped items directly at root alongside group nodes', () => {
      const items = [
        makeItem({ id: '1', title: 'Ungrouped', state: WorkItemState.InProgress }),
        makeItem({ id: '2', title: 'Grouped', state: WorkItemState.InProgress, group: 'contoso/webapp' }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      const groups = children.filter(c => isSubGroupNode(c)) as SubGroupNode[];
      const directItems = children.filter(c => !isSubGroupNode(c)) as WorkItem[];
      expect(groups).toHaveLength(1);
      expect(groups[0].groupName).toBe('contoso/webapp');
      expect(directItems).toHaveLength(1);
      expect(directItems[0].title).toBe('Ungrouped');
    });

    it('returns items for a group node', () => {
      const items = [
        makeItem({ id: '1', title: 'A', providerId: 'github', state: WorkItemState.InProgress, group: 'contoso/webapp' }),
        makeItem({ id: '2', title: 'B', providerId: 'github', state: WorkItemState.InProgress, group: 'contoso/webapp' }),
        makeItem({ id: '3', title: 'C', providerId: 'github', state: WorkItemState.Paused, group: 'myorg/api' }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const group: SubGroupNode = { kind: 'subGroup', label: 'contoso/webapp', providerId: undefined, groupName: 'contoso/webapp' };
      const children = provider.getChildren(group);
      expect(children).toHaveLength(2);
    });

    it('renders group node with folder icon', () => {
      const group: SubGroupNode = { kind: 'subGroup', label: 'contoso/webapp', providerId: undefined, groupName: 'contoso/webapp' };
      const treeItem = provider.getTreeItem(group);
      expect(treeItem.label).toBe('contoso/webapp');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect((treeItem.iconPath as any).id).toBe('folder');
    });

    it('sorts group nodes alphabetically', () => {
      const items = [
        makeItem({ id: '1', title: 'A', state: WorkItemState.InProgress, group: 'z-repo' }),
        makeItem({ id: '2', title: 'B', state: WorkItemState.InProgress, group: 'a-repo' }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const children = provider.getChildren();
      expect((children[0] as SubGroupNode).label).toBe('a-repo');
      expect((children[1] as SubGroupNode).label).toBe('z-repo');
    });

    it('returns empty for item node children', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.InProgress });
      expect(provider.getChildren(item)).toEqual([]);
    });

    it('normalizes whitespace-only groups as ungrouped', () => {
      const items = [
        makeItem({ id: '1', title: 'Whitespace', state: WorkItemState.InProgress, group: '   ' }),
        makeItem({ id: '2', title: 'Grouped', state: WorkItemState.InProgress, group: 'contoso/webapp' }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const children = provider.getChildren();
      const groups = children.filter(c => isSubGroupNode(c)) as SubGroupNode[];
      const directItems = children.filter(c => !isSubGroupNode(c)) as WorkItem[];
      expect(groups).toHaveLength(1);
      expect(groups[0].groupName).toBe('contoso/webapp');
      expect(directItems).toHaveLength(1);
    });
  });
});
