import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter, TreeItemCollapsibleState, ThemeIcon } from 'vscode';
import { DiscoveredItem } from '../api/types';
import { SourcesTreeProvider, SourceProviderNode, SourceGroupNode, SourceItemNode } from '../views/sourcesTreeProvider';

function createMockStateStore() {
  const cache = new Map<string, string>();
  const emitter = new EventEmitter<void>();
  return {
    getState: vi.fn((providerId: string, externalId: string) =>
      cache.get(`${providerId}::${externalId}`) as any,
    ),
    setState: vi.fn(async (providerId: string, externalId: string, state: string) => {
      cache.set(`${providerId}::${externalId}`, state);
    }),
    load: vi.fn(async () => {}),
    loadAll: vi.fn(async () => []),
    onDidChange: emitter.event,
    dispose: vi.fn(),
    _set: (providerId: string, externalId: string, state: string) => {
      cache.set(`${providerId}::${externalId}`, state);
    },
    _fire: () => emitter.fire(),
  };
}

function createMockProviderRegistry() {
  const items = new Map<string, DiscoveredItem[]>();
  const labels = new Map<string, string>();
  const emitter = new EventEmitter<void>();
  return {
    getAllDiscoveredItems: vi.fn(() => items),
    getDiscoveredItems: vi.fn((id: string) => items.get(id) ?? []),
    getProviderLabel: vi.fn((id: string) => labels.get(id) ?? id),
    onDidChangeDiscoveredItems: emitter.event,
    _setItems: (providerId: string, discoveredItems: DiscoveredItem[]) => {
      items.set(providerId, discoveredItems);
    },
    _setLabel: (providerId: string, label: string) => {
      labels.set(providerId, label);
    },
    _fire: () => emitter.fire(),
  };
}

describe('SourcesTreeProvider', () => {
  let stateStore: ReturnType<typeof createMockStateStore>;
  let registry: ReturnType<typeof createMockProviderRegistry>;
  let provider: SourcesTreeProvider;

  beforeEach(() => {
    stateStore = createMockStateStore();
    registry = createMockProviderRegistry();
    provider = new SourcesTreeProvider(registry as any, stateStore as any);
  });

  describe('top-level (no element)', () => {
    it('should return empty when no discovered items exist', () => {
      const children = provider.getChildren();
      expect(children).toEqual([]);
    });

    it('should return provider nodes at top level', () => {
      registry._setLabel('gh', 'GitHub Issues');
      registry._setItems('gh', [
        { externalId: 'issue-1', title: 'Bug' },
      ]);

      const children = provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0].kind).toBe('provider');
      expect((children[0] as SourceProviderNode).label).toBe('GitHub Issues');
      expect((children[0] as SourceProviderNode).providerId).toBe('gh');
    });

    it('should show multiple provider nodes', () => {
      registry._setLabel('gh', 'GitHub');
      registry._setLabel('jira', 'Jira');
      registry._setItems('gh', [{ externalId: '1', title: 'A' }]);
      registry._setItems('jira', [{ externalId: '2', title: 'B' }]);

      const children = provider.getChildren();
      expect(children).toHaveLength(2);
    });

    it('should hide provider with empty items', () => {
      registry._setItems('gh', []);

      const children = provider.getChildren();
      expect(children).toHaveLength(0);
    });
  });

  describe('provider children', () => {
    it('should show group nodes when items have groups', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'PR #1', group: 'Pull Requests' },
        { externalId: '2', title: 'Issue #1', group: 'Issues' },
      ]);

      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GitHub' };
      const children = provider.getChildren(providerNode);

      expect(children).toHaveLength(2);
      expect(children.every((c) => c.kind === 'group')).toBe(true);
      const groupNames = children.map((c) => (c as SourceGroupNode).groupName).sort();
      expect(groupNames).toEqual(['Issues', 'Pull Requests']);
    });

    it('should show flat items when no groups are set', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Item A' },
        { externalId: '2', title: 'Item B' },
      ]);

      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GitHub' };
      const children = provider.getChildren(providerNode);

      expect(children).toHaveLength(2);
      expect(children.every((c) => c.kind === 'item')).toBe(true);
    });

    it('should mix groups and ungrouped items', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Grouped', group: 'PRs' },
        { externalId: '2', title: 'Ungrouped' },
      ]);

      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GitHub' };
      const children = provider.getChildren(providerNode);

      expect(children).toHaveLength(2);
      const kinds = children.map((c) => c.kind);
      expect(kinds).toContain('group');
      expect(kinds).toContain('item');
    });
  });

  describe('group children', () => {
    it('should expand group node to show only items in that group', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'PR #1', group: 'Pull Requests' },
        { externalId: '2', title: 'PR #2', group: 'Pull Requests' },
        { externalId: '3', title: 'Issue #1', group: 'Issues' },
      ]);

      const groupNode: SourceGroupNode = { kind: 'group', providerId: 'gh', groupName: 'Pull Requests' };
      const children = provider.getChildren(groupNode);

      expect(children).toHaveLength(2);
      expect(children.every((c) => c.kind === 'item')).toBe(true);
      expect(children.map((c) => (c as SourceItemNode).title)).toEqual(['PR #1', 'PR #2']);
    });
  });

  describe('item children', () => {
    it('should return empty array for item nodes', () => {
      const itemNode: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Item',
      };
      const children = provider.getChildren(itemNode);
      expect(children).toEqual([]);
    });
  });

  describe('shows ALL items regardless of inboxState', () => {
    it('should show unseen items', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'Unseen' }]);
      stateStore._set('gh', '1', 'unseen');

      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GH' };
      const children = provider.getChildren(providerNode);
      expect(children).toHaveLength(1);
    });

    it('should show accepted items', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'Accepted' }]);
      stateStore._set('gh', '1', 'accepted');

      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GH' };
      const children = provider.getChildren(providerNode);
      expect(children).toHaveLength(1);
    });

    it('should show dismissed items', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'Dismissed' }]);
      stateStore._set('gh', '1', 'dismissed');

      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GH' };
      const children = provider.getChildren(providerNode);
      expect(children).toHaveLength(1);
    });
  });

  describe('getTreeItem', () => {
    it('should render provider node with plug icon and collapsed state', () => {
      const node: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GitHub Issues' };
      const treeItem = provider.getTreeItem(node);

      expect(treeItem.label).toBe('GitHub Issues');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect(treeItem.contextValue).toBe('sourceProvider');
      expect((treeItem.iconPath as any).id).toBe('plug');
    });

    it('should render group node with folder icon and collapsed state', () => {
      const node: SourceGroupNode = { kind: 'group', providerId: 'gh', groupName: 'Pull Requests' };
      const treeItem = provider.getTreeItem(node);

      expect(treeItem.label).toBe('Pull Requests');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect(treeItem.contextValue).toBe('sourceGroup');
      expect((treeItem.iconPath as any).id).toBe('folder');
    });

    it('should render accepted item with check icon', () => {
      stateStore.getState.mockReturnValue('accepted');

      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Accepted Item',
      };
      const treeItem = provider.getTreeItem(node);

      expect(treeItem.label).toBe('Accepted Item');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect((treeItem.iconPath as any).id).toBe('check');
    });

    it('should render non-accepted item with circle-outline icon', () => {
      stateStore.getState.mockReturnValue('unseen');

      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Unseen Item',
      };
      const treeItem = provider.getTreeItem(node);
      expect((treeItem.iconPath as any).id).toBe('circle-outline');
    });

    it('should render dismissed item with circle-outline icon and dismissed description', () => {
      stateStore.getState.mockReturnValue('dismissed');

      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Dismissed Item',
      };
      const treeItem = provider.getTreeItem(node);
      expect((treeItem.iconPath as any).id).toBe('circle-outline');
      expect(treeItem.description).toBe('dismissed');
    });

    it('should set contextValue with hasUrl when item has url', () => {
      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Item', url: 'https://example.com',
      };
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.contextValue).toBe('sourceItem.hasUrl');
    });

    it('should set contextValue without hasUrl when item lacks url', () => {
      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Item',
      };
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.contextValue).toBe('sourceItem');
    });
  });

  describe('refresh', () => {
    it('should refresh when providerRegistry fires change event', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      registry._fire();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should refresh when stateStore fires change event', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      stateStore._fire();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
