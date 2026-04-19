import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter, TreeItemCollapsibleState } from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { FocusTreeProvider } from '../views/focusTreeProvider';
import { isSubGroupNode, SubGroupNode, isProviderGroupNode, ProviderGroupNode } from '../views/viewLayout';

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

    it('returns provider group nodes at top level', () => {
      const items = [
        makeItem({ id: '1', title: 'A', providerId: 'github', state: WorkItemState.InProgress, group: 'contoso/webapp' }),
        makeItem({ id: '2', title: 'B', providerId: 'jira', state: WorkItemState.Paused, group: 'myorg/api' }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every(c => isProviderGroupNode(c))).toBe(true);
      const labels = children.map(c => (c as ProviderGroupNode).label);
      expect(labels).toContain('GitHub');
      expect(labels).toContain('Jira');
    });

    it('groups items without providerId under "Other" provider node', () => {
      const items = [
        makeItem({ id: '1', title: 'Ungrouped', state: WorkItemState.InProgress }),
        makeItem({ id: '2', title: 'Grouped', providerId: 'github', state: WorkItemState.InProgress, group: 'contoso/webapp' }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      const providerGroups = children.filter(c => isProviderGroupNode(c)) as ProviderGroupNode[];
      expect(providerGroups).toHaveLength(2);
      const otherGroup = providerGroups.find(g => g.label === 'Other');
      const githubGroup = providerGroups.find(g => g.label === 'GitHub');
      expect(otherGroup).toBeDefined();
      expect(githubGroup).toBeDefined();
    });

    it('returns sub-groups and items for a provider node', () => {
      const items = [
        makeItem({ id: '1', title: 'A', providerId: 'github', state: WorkItemState.InProgress, group: 'contoso/webapp' }),
        makeItem({ id: '2', title: 'B', providerId: 'github', state: WorkItemState.InProgress, group: 'contoso/webapp' }),
        makeItem({ id: '3', title: 'C', providerId: 'github', state: WorkItemState.Paused, group: 'myorg/api' }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const providerNode: ProviderGroupNode = { kind: 'providerGroup', label: 'GitHub', providerId: 'github' };
      const children = provider.getChildren(providerNode);
      expect(children).toHaveLength(2);
      expect(children.every(c => isSubGroupNode(c))).toBe(true);
      const labels = children.map(c => (c as SubGroupNode).label);
      expect(labels).toContain('contoso/webapp');
      expect(labels).toContain('myorg/api');
    });

    it('renders sub-group node with folder icon', () => {
      const group: SubGroupNode = { kind: 'subGroup', label: 'contoso/webapp', providerId: 'github', groupName: 'contoso/webapp' };
      const treeItem = provider.getTreeItem(group);
      expect(treeItem.label).toBe('contoso/webapp');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect((treeItem.iconPath as any).id).toBe('folder');
    });

    it('shows item count in sub-group description', () => {
      const items = [
        makeItem({ id: '1', title: 'A', providerId: 'github', state: WorkItemState.InProgress, group: 'contoso/webapp' }),
        makeItem({ id: '2', title: 'B', providerId: 'github', state: WorkItemState.InProgress, group: 'contoso/webapp' }),
        makeItem({ id: '3', title: 'C', providerId: 'github', state: WorkItemState.InProgress, group: 'fabrikam/api' }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);

      const group: SubGroupNode = { kind: 'subGroup', label: 'contoso/webapp', providerId: 'github', groupName: 'contoso/webapp' };
      const treeItem = provider.getTreeItem(group);
      expect(treeItem.description).toBe('2');
    });

    it('normalizes whitespace in group name for count computation', () => {
      const items = [
        makeItem({ id: '1', title: 'A', providerId: 'github', state: WorkItemState.InProgress, group: 'valid-group' }),
        makeItem({ id: '2', title: 'B', providerId: 'github', state: WorkItemState.InProgress, group: 'valid-group  ' }),
        makeItem({ id: '3', title: 'C', providerId: 'github', state: WorkItemState.InProgress, group: '  valid-group' }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);

      const group: SubGroupNode = { kind: 'subGroup', label: 'valid-group', providerId: 'github', groupName: 'valid-group' };
      const treeItem = provider.getTreeItem(group);
      expect(treeItem.description).toBe('3');
    });

    it('sorts provider nodes alphabetically, with "Other" last', () => {
      const items = [
        makeItem({ id: '1', title: 'A', providerId: 'jira', state: WorkItemState.InProgress }),
        makeItem({ id: '2', title: 'B', providerId: 'github', state: WorkItemState.InProgress }),
        makeItem({ id: '3', title: 'C', state: WorkItemState.InProgress }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const children = provider.getChildren();
      expect(children).toHaveLength(3);
      expect((children[0] as ProviderGroupNode).label).toBe('GitHub');
      expect((children[1] as ProviderGroupNode).label).toBe('Jira');
      expect((children[2] as ProviderGroupNode).label).toBe('Other');
    });

    it('returns empty for item node children', () => {
      const item = makeItem({ id: '1', title: 'X', state: WorkItemState.InProgress });
      expect(provider.getChildren(item)).toEqual([]);
    });

    it('normalizes whitespace-only groups as ungrouped within provider', () => {
      const items = [
        makeItem({ id: '1', title: 'Whitespace', providerId: 'github', state: WorkItemState.InProgress, group: '   ' }),
        makeItem({ id: '2', title: 'Grouped', providerId: 'github', state: WorkItemState.InProgress, group: 'contoso/webapp' }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const providerNode: ProviderGroupNode = { kind: 'providerGroup', label: 'GitHub', providerId: 'github' };
      const children = provider.getChildren(providerNode);
      const subGroups = children.filter(c => isSubGroupNode(c)) as SubGroupNode[];
      const directItems = children.filter(c => !isSubGroupNode(c) && !isProviderGroupNode(c)) as WorkItem[];
      expect(subGroups).toHaveLength(1);
      expect(subGroups[0].groupName).toBe('contoso/webapp');
      expect(directItems).toHaveLength(1);
      expect(directItems[0].title).toBe('Whitespace');
    });
  });
});
