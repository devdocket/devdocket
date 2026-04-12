import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter, TreeItemCollapsibleState } from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { FocusTreeProvider } from '../views/focusTreeProvider';
import { isProviderGroupNode, isSubGroupNode, ProviderGroupNode, SubGroupNode } from '../views/viewLayout';

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

    it('returns provider group nodes with display names at top level', () => {
      const items = [
        makeItem({ id: '1', title: 'A', providerId: 'github', state: WorkItemState.InProgress }),
        makeItem({ id: '2', title: 'B', providerId: 'jira', state: WorkItemState.Paused }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every(c => isProviderGroupNode(c))).toBe(true);
      const labels = children.map(c => (c as ProviderGroupNode).label);
      expect(labels).toContain('GitHub');
      expect(labels).toContain('Jira');
    });

    it('groups items without providerId under "Other"', () => {
      const items = [
        makeItem({ id: '1', title: 'Manual', state: WorkItemState.InProgress }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const children = provider.getChildren();
      expect(children).toHaveLength(1);
      expect((children[0] as ProviderGroupNode).label).toBe('Other');
    });

    it('returns items for a provider group', () => {
      const items = [
        makeItem({ id: '1', title: 'A', providerId: 'github', state: WorkItemState.InProgress }),
        makeItem({ id: '2', title: 'B', providerId: 'jira', state: WorkItemState.Paused }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const group: ProviderGroupNode = { kind: 'providerGroup', label: 'github', providerId: 'github' };
      const children = provider.getChildren(group);
      expect(children.length).toBeGreaterThanOrEqual(1);
    });

    it('renders group node correctly', () => {
      const group: ProviderGroupNode = { kind: 'providerGroup', label: 'GitHub', providerId: 'github' };
      const treeItem = provider.getTreeItem(group);
      expect(treeItem.label).toBe('GitHub');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect(treeItem.contextValue).toBe('focusGroup');
      expect((treeItem.iconPath as any).id).toBe('plug');
    });

    it('renders "Other" group with circle-filled icon', () => {
      const group: ProviderGroupNode = { kind: 'providerGroup', label: 'Other', providerId: undefined };
      const treeItem = provider.getTreeItem(group);
      expect((treeItem.iconPath as any).id).toBe('circle-filled');
    });

    it('groups items by sub-group within a provider', () => {
      const items = [
        makeItem({ id: '1', title: 'Bug A', providerId: 'github', state: WorkItemState.InProgress, group: 'bugs' }),
        makeItem({ id: '2', title: 'Bug B', providerId: 'github', state: WorkItemState.InProgress, group: 'bugs' }),
        makeItem({ id: '3', title: 'Feature', providerId: 'github', state: WorkItemState.Paused, group: 'features' }),
        makeItem({ id: '4', title: 'Ungrouped', providerId: 'github', state: WorkItemState.InProgress }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const topLevel = provider.getChildren();
      expect(topLevel).toHaveLength(1);

      const providerChildren = provider.getChildren(topLevel[0]);
      const subGroups = providerChildren.filter(c => isSubGroupNode(c)) as SubGroupNode[];
      const directItems = providerChildren.filter(c => !isSubGroupNode(c));
      expect(subGroups).toHaveLength(2);
      expect(subGroups.map(g => g.groupName).sort()).toEqual(['bugs', 'features']);
      expect(directItems).toHaveLength(1);
    });

    it('returns items for a sub-group', () => {
      const items = [
        makeItem({ id: '1', title: 'Bug A', providerId: 'github', state: WorkItemState.InProgress, group: 'bugs' }),
        makeItem({ id: '2', title: 'Bug B', providerId: 'github', state: WorkItemState.InProgress, group: 'bugs' }),
        makeItem({ id: '3', title: 'Feature', providerId: 'github', state: WorkItemState.Paused, group: 'features' }),
      ];
      workGraph.getItemsByState.mockReturnValue(items);
      const subGroup: SubGroupNode = { kind: 'subGroup', label: 'bugs', providerId: 'github', groupName: 'bugs' };
      const children = provider.getChildren(subGroup);
      expect(children).toHaveLength(2);
    });

    it('renders sub-group node with folder icon', () => {
      const subGroup: SubGroupNode = { kind: 'subGroup', label: 'bugs', providerId: 'github', groupName: 'bugs' };
      const treeItem = provider.getTreeItem(subGroup);
      expect(treeItem.label).toBe('bugs');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect((treeItem.iconPath as any).id).toBe('folder');
    });
  });
});
