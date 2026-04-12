import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TreeItemCollapsibleState } from 'vscode';
import { WorkGraph } from '../services/workGraph';
import { WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';
import { QueueTreeProvider } from '../views/queueTreeProvider';
import { isProviderGroupNode, isSubGroupNode, ProviderGroupNode, SubGroupNode } from '../views/viewLayout';

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    saveAll: vi.fn(async (batch) => { for (const item of batch) { items.set(item.id, item); } }),
    delete: vi.fn(async (id) => { items.delete(id); }),
  };
}

describe('QueueTreeProvider layout toggle', () => {
  let store: ITaskStore;
  let graph: WorkGraph;
  let provider: QueueTreeProvider;
  const mockRegistry = {
    getProviderLabel: vi.fn((id: string) => {
      const labels: Record<string, string> = { github: 'GitHub', jira: 'Jira', alpha: 'Alpha Provider' };
      return labels[id] ?? id;
    }),
  };

  beforeEach(async () => {
    store = createMockStore();
    graph = new WorkGraph(store);
    await graph.load();
    provider = new QueueTreeProvider(graph, mockRegistry as any);
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
    it('returns work items directly', async () => {
      await graph.createItem({ title: 'A' });
      await graph.createItem({ title: 'B' });
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every(c => !isProviderGroupNode(c))).toBe(true);
    });
  });

  describe('tree mode', () => {
    beforeEach(() => {
      provider.layout = 'tree';
    });

    it('returns provider group nodes at top level', async () => {
      await graph.createItem({ title: 'A' }, { providerId: 'github', externalId: 'ext-1' });
      await graph.createItem({ title: 'B' }, { providerId: 'jira', externalId: 'ext-2' });
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every(c => isProviderGroupNode(c))).toBe(true);
    });

    it('groups manual items under "Other"', async () => {
      await graph.createItem({ title: 'Manual' });
      await graph.createItem({ title: 'Provider' }, { providerId: 'github', externalId: 'ext-1' });
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      const labels = children.map(c => (c as ProviderGroupNode).label);
      expect(labels).toContain('Other');
      expect(labels).toContain('GitHub');
    });

    it('sorts "Other" group last', async () => {
      await graph.createItem({ title: 'Manual' });
      await graph.createItem({ title: 'Provider' }, { providerId: 'alpha', externalId: 'ext-1' });
      const children = provider.getChildren();
      expect((children[children.length - 1] as ProviderGroupNode).label).toBe('Other');
      expect((children[0] as ProviderGroupNode).label).toBe('Alpha Provider');
    });

    it('returns items for a provider group', async () => {
      await graph.createItem({ title: 'A' }, { providerId: 'github', externalId: 'ext-1' });
      await graph.createItem({ title: 'B' }, { providerId: 'github', externalId: 'ext-2' });
      await graph.createItem({ title: 'C' }, { providerId: 'jira', externalId: 'ext-3' });
      const group: ProviderGroupNode = { kind: 'providerGroup', label: 'github', providerId: 'github' };
      const children = provider.getChildren(group);
      expect(children).toHaveLength(2);
      expect(children.every(c => !isProviderGroupNode(c))).toBe(true);
    });

    it('renders group node as collapsed tree item', async () => {
      const group: ProviderGroupNode = { kind: 'providerGroup', label: 'GitHub', providerId: 'github' };
      const treeItem = provider.getTreeItem(group);
      expect(treeItem.label).toBe('GitHub');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect(treeItem.contextValue).toBe('queueGroup');
      expect((treeItem.iconPath as any).id).toBe('plug');
    });

    it('renders "Other" group with circle-filled icon', () => {
      const group: ProviderGroupNode = { kind: 'providerGroup', label: 'Other', providerId: undefined };
      const treeItem = provider.getTreeItem(group);
      expect((treeItem.iconPath as any).id).toBe('circle-filled');
    });

    it('returns empty when no items exist', () => {
      const children = provider.getChildren();
      expect(children).toEqual([]);
    });

    it('groups items by sub-group within a provider', async () => {
      await graph.createItem({ title: 'Bug A' }, { providerId: 'github', externalId: 'ext-1', group: 'bugs' });
      await graph.createItem({ title: 'Bug B' }, { providerId: 'github', externalId: 'ext-2', group: 'bugs' });
      await graph.createItem({ title: 'Feature C' }, { providerId: 'github', externalId: 'ext-3', group: 'features' });
      await graph.createItem({ title: 'Ungrouped' }, { providerId: 'github', externalId: 'ext-4' });

      const topLevel = provider.getChildren();
      expect(topLevel).toHaveLength(1);
      expect(isProviderGroupNode(topLevel[0])).toBe(true);

      const providerChildren = provider.getChildren(topLevel[0]);
      const subGroups = providerChildren.filter(c => isSubGroupNode(c)) as SubGroupNode[];
      const directItems = providerChildren.filter(c => !isSubGroupNode(c));

      expect(subGroups).toHaveLength(2);
      expect(subGroups.map(g => g.groupName).sort()).toEqual(['bugs', 'features']);
      expect(directItems).toHaveLength(1);
      expect((directItems[0] as any).title).toBe('Ungrouped');
    });

    it('returns items for a sub-group', async () => {
      await graph.createItem({ title: 'Bug A' }, { providerId: 'github', externalId: 'ext-1', group: 'bugs' });
      await graph.createItem({ title: 'Bug B' }, { providerId: 'github', externalId: 'ext-2', group: 'bugs' });
      await graph.createItem({ title: 'Feature C' }, { providerId: 'github', externalId: 'ext-3', group: 'features' });

      const subGroup: SubGroupNode = { kind: 'subGroup', label: 'bugs', providerId: 'github', groupName: 'bugs' };
      const children = provider.getChildren(subGroup);
      expect(children).toHaveLength(2);
      expect(children.every(c => !isSubGroupNode(c) && !isProviderGroupNode(c))).toBe(true);
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
