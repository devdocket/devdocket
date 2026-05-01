import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter, MarkdownString, TreeItemCollapsibleState, ThemeIcon } from 'vscode';
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
  const healthEmitter = new EventEmitter<string>();
  return {
    getAllDiscoveredItems: vi.fn(() => items),
    getDiscoveredItems: vi.fn((id: string) => items.get(id) ?? []),
    getProviderLabel: vi.fn((id: string) => labels.get(id) ?? id),
    getProviderHealth: vi.fn(() => ({ status: 'unknown' as const })),
    onDidChangeDiscoveredItems: emitter.event,
    onDidChangeProviderHealth: healthEmitter.event,
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

    it('should show multiple provider nodes sorted alphabetically', () => {
      registry._setLabel('gh', 'GitHub');
      registry._setLabel('jira', 'Jira');
      registry._setLabel('ado', 'Azure DevOps');
      registry._setItems('gh', [{ externalId: '1', title: 'A' }]);
      registry._setItems('jira', [{ externalId: '2', title: 'B' }]);
      registry._setItems('ado', [{ externalId: '3', title: 'C' }]);

      const children = provider.getChildren();
      expect(children).toHaveLength(3);
      const labels = children.map((c) => (c as SourceProviderNode).label);
      expect(labels).toEqual(['Azure DevOps', 'GitHub', 'Jira']);
    });

    it('should handle duplicate provider labels from different provider IDs', () => {
      registry._setLabel('gh1', 'GitHub');
      registry._setLabel('gh2', 'GitHub');
      registry._setItems('gh1', [{ externalId: '1', title: 'A' }]);
      registry._setItems('gh2', [{ externalId: '2', title: 'B' }]);

      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every((c) => (c as SourceProviderNode).label === 'GitHub')).toBe(true);
      const ids = children.map((c) => (c as SourceProviderNode).providerId).sort();
      expect(ids).toEqual(['gh1', 'gh2']);
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

    it('nests related source items under their parent item', () => {
      registry._setItems('github-my-prs', [{
        externalId: 'owner/repo#42',
        title: 'PR 42',
        relatedItems: [{ externalId: 'owner/repo#7', relation: 'linked' }],
      }]);
      registry._setItems('github', [{ externalId: 'owner/repo#7', title: 'Issue 7' }]);

      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'github-my-prs', label: 'GitHub My PRs' };
      const parentItems = provider.getChildren(providerNode) as SourceItemNode[];
      expect(parentItems).toHaveLength(1);

      const linkedChildren = provider.getChildren(parentItems[0]) as SourceItemNode[];
      expect(linkedChildren).toHaveLength(1);
      expect(linkedChildren[0].externalId).toBe('owner/repo#7');
      expect(provider.getTreeItem(parentItems[0]).collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect(provider.getTreeItem(linkedChildren[0]).description).toBe('Linked to #42');
    });

    it('should sort children alphabetically (groups and items mixed)', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Zebra' },
        { externalId: '2', title: 'Grouped', group: 'Alpha Group' },
        { externalId: '3', title: 'Apple' },
      ]);

      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GitHub' };
      const children = provider.getChildren(providerNode);

      expect(children).toHaveLength(3);
      const labels = children.map((c) =>
        c.kind === 'group' ? (c as SourceGroupNode).groupName : (c as SourceItemNode).title,
      );
      expect(labels).toEqual(['Alpha Group', 'Apple', 'Zebra']);
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

    it('should pass through group field on items', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'PR #1', group: 'dotnet/runtime' },
      ]);

      const groupNode: SourceGroupNode = { kind: 'group', providerId: 'gh', groupName: 'dotnet/runtime' };
      const children = provider.getChildren(groupNode);

      expect(children).toHaveLength(1);
      expect((children[0] as SourceItemNode).group).toBe('dotnet/runtime');
    });

    it('should leave group undefined for ungrouped items', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Item A' },
      ]);

      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GH' };
      const children = provider.getChildren(providerNode);

      expect(children).toHaveLength(1);
      expect((children[0] as SourceItemNode).group).toBeUndefined();
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

    it('should render unseen item with circle-outline icon', () => {
      stateStore.getState.mockReturnValue('unseen');

      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Unseen Item',
      };
      const treeItem = provider.getTreeItem(node);
      expect((treeItem.iconPath as any).id).toBe('circle-outline');
    });

    it('should render dismissed item with circle-slash icon and dismissed description', () => {
      stateStore.getState.mockReturnValue('dismissed');

      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Dismissed Item',
      };
      const treeItem = provider.getTreeItem(node);
      expect((treeItem.iconPath as any).id).toBe('circle-slash');
      expect(treeItem.description).toBe('dismissed');
    });

    it('should show provider label in flat layout', () => {
      registry._setLabel('gh', 'GitHub Issues');
      provider.layout = 'flat';
      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Item',
      };
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.description).toBe('GitHub Issues');
    });

    it('should show group and provider label in flat layout', () => {
      registry._setLabel('gh', 'GitHub Issues');
      provider.layout = 'flat';
      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Item', group: 'octocat/repo',
      };
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.description).toBe('octocat/repo · GitHub Issues');
    });

    it('should show provider label and dismissed in flat layout', () => {
      registry._setLabel('gh', 'GitHub Issues');
      stateStore.getState.mockReturnValue('dismissed');
      provider.layout = 'flat';
      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Dismissed Item',
      };
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.description).toBe('GitHub Issues · dismissed');
    });

    it('should show group, provider label, and dismissed in flat layout', () => {
      registry._setLabel('gh', 'GitHub Issues');
      stateStore.getState.mockReturnValue('dismissed');
      provider.layout = 'flat';
      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Dismissed Item', group: 'octocat/repo',
      };
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.description).toBe('octocat/repo · GitHub Issues · dismissed');
    });

    it('should omit provider label in tree layout', () => {
      registry._setLabel('gh', 'GitHub Issues');
      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Item',
      };
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.description).toBeUndefined();
    });

    it('should use distinct icons for accepted, dismissed, and unseen states', () => {
      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Test Item',
      };

      stateStore.getState.mockReturnValue('accepted');
      const acceptedIcon = (provider.getTreeItem(node).iconPath as any).id;

      stateStore.getState.mockReturnValue('dismissed');
      const dismissedIcon = (provider.getTreeItem(node).iconPath as any).id;

      stateStore.getState.mockReturnValue('unseen');
      const unseenIcon = (provider.getTreeItem(node).iconPath as any).id;

      const icons = new Set([acceptedIcon, dismissedIcon, unseenIcon]);
      expect(icons.size).toBe(3);
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

  describe('getTreeItem tooltip', () => {
    it('should include title but not description in tooltip', () => {
      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug Report',
        description: 'App crashes on startup',
      };
      const treeItem = provider.getTreeItem(node);
      const tooltip = treeItem.tooltip as MarkdownString;
      expect(tooltip.value).toContain('Bug Report');
      expect(tooltip.value).not.toContain('App crashes on startup');
      expect(tooltip.value).not.toContain('**Description:**');
    });

    it('should include only title in tooltip when item has no description', () => {
      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Simple Item',
      };
      const treeItem = provider.getTreeItem(node);
      const tooltip = treeItem.tooltip as MarkdownString;
      expect(tooltip.value).toContain('Simple Item');
      expect(tooltip.value).not.toContain('**Description:**');
    });
  });

  describe('sorting', () => {
    it('should sort provider nodes alphabetically by label', () => {
      registry._setLabel('zz', 'Zeta Provider');
      registry._setLabel('aa', 'Alpha Provider');
      registry._setLabel('mm', 'Mid Provider');
      registry._setItems('zz', [{ externalId: '1', title: 'Z' }]);
      registry._setItems('aa', [{ externalId: '2', title: 'A' }]);
      registry._setItems('mm', [{ externalId: '3', title: 'M' }]);

      const children = provider.getChildren();
      const labels = children.map((c) => (c as SourceProviderNode).label);
      expect(labels).toEqual(['Alpha Provider', 'Mid Provider', 'Zeta Provider']);
    });

    it('should sort group children alphabetically by title', () => {
      registry._setItems('gh', [
        { externalId: '3', title: 'Zebra', group: 'Animals' },
        { externalId: '1', title: 'Aardvark', group: 'Animals' },
        { externalId: '2', title: 'Meerkat', group: 'Animals' },
      ]);

      const groupNode: SourceGroupNode = { kind: 'group', providerId: 'gh', groupName: 'Animals' };
      const children = provider.getChildren(groupNode);
      const titles = children.map((c) => (c as SourceItemNode).title);
      expect(titles).toEqual(['Aardvark', 'Meerkat', 'Zebra']);
    });

    it('should sort group nodes alphabetically by group name', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'X', group: 'Zulu' },
        { externalId: '2', title: 'Y', group: 'Alpha' },
        { externalId: '3', title: 'Z', group: 'Mike' },
      ]);

      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GH' };
      const children = provider.getChildren(providerNode);
      const groupNames = children.map((c) => (c as SourceGroupNode).groupName);
      expect(groupNames).toEqual(['Alpha', 'Mike', 'Zulu']);
    });

    it('should trim whitespace from group names when grouping', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Issue A', group: ' repo-one ' },
        { externalId: '2', title: 'Issue B', group: 'repo-one' },
      ]);

      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GH' };
      const children = provider.getChildren(providerNode);
      expect(children).toHaveLength(1);
      expect(children[0].kind).toBe('group');
      expect((children[0] as SourceGroupNode).groupName).toBe('repo-one');
    });

    it('should treat whitespace-only group as ungrouped', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Whitespace', group: '  ' },
        { externalId: '2', title: 'Normal', group: 'repo' },
      ]);

      const providerNode: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GH' };
      const children = provider.getChildren(providerNode);
      expect(children).toHaveLength(2);
      const group = children.find(c => c.kind === 'group') as SourceGroupNode;
      const item = children.find(c => c.kind === 'item') as SourceItemNode;
      expect(group.groupName).toBe('repo');
      expect(item.title).toBe('Whitespace');
    });

    it('should show trimmed group in flat layout description', () => {
      registry._setLabel('gh', 'GitHub Issues');
      provider.layout = 'flat';
      registry._setItems('gh', [
        { externalId: '1', title: 'Item', group: '  octocat/repo  ' },
      ]);
      const children = provider.getChildren();
      const treeItem = provider.getTreeItem(children[0]);
      expect(treeItem.description).toBe('octocat/repo · GitHub Issues');
    });
  });

  describe('dispose', () => {
    it('should stop firing tree data changes after dispose', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      registry._fire();
      expect(listener).toHaveBeenCalledTimes(1);

      provider.dispose();

      registry._fire();
      stateStore._fire();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('edge cases', () => {
    it('should return empty children for a group with no matching items', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'PR #1', group: 'Pull Requests' },
      ]);

      const groupNode: SourceGroupNode = { kind: 'group', providerId: 'gh', groupName: 'Nonexistent Group' };
      const children = provider.getChildren(groupNode);
      expect(children).toEqual([]);
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

    it('should refresh when refresh() is called explicitly', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      provider.refresh();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('tooltip', () => {
    it('should include title in tooltip', () => {
      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'My Item',
      };
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.tooltip).toBeDefined();
      expect((treeItem.tooltip as any).value).toContain('My Item');
      expect((treeItem.tooltip as any).value).not.toContain('Description');
    });

    it('should not include description in tooltip even when present', () => {
      const node: SourceItemNode = {
        kind: 'item', providerId: 'gh', externalId: '1', title: 'Item', description: 'Details here',
      };
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.tooltip).toBeDefined();
      expect((treeItem.tooltip as any).value).toContain('Item');
      expect((treeItem.tooltip as any).value).not.toContain('Details here');
    });
  });

  describe('dispose', () => {
    it('should dispose without errors', () => {
      expect(() => provider.dispose()).not.toThrow();
    });

    it('should not fire events after dispose', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      provider.dispose();
      provider.refresh();
      registry._fire();
      stateStore._fire();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('unhealthy provider rendering', () => {
    it('shows warning icon for unhealthy provider', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Bug' }]);
      registry.getProviderHealth.mockReturnValue({
        status: 'unhealthy',
        lastError: 'network error',
        lastRefreshTime: new Date(0),
      });

      const node: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GitHub' };
      const treeItem = provider.getTreeItem(node);
      expect((treeItem.iconPath as any).id).toBe('warning');
      expect(treeItem.description).toBe('refresh failed');
    });

    it('shows plug icon for healthy provider', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Bug' }]);
      registry.getProviderHealth.mockReturnValue({
        status: 'healthy',
        lastRefreshTime: new Date(),
      });

      const node: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GitHub' };
      const treeItem = provider.getTreeItem(node);
      expect((treeItem.iconPath as any).id).toBe('plug');
    });

    it('shows item count for healthy provider', () => {
      registry._setItems('gh', [
        { externalId: 'issue-1', title: 'Bug A' },
        { externalId: 'issue-2', title: 'Bug B' },
        { externalId: 'issue-3', title: 'Feature C' }
      ]);
      registry.getProviderHealth.mockReturnValue({
        status: 'healthy',
        lastRefreshTime: new Date(),
      });

      const node: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GitHub' };
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.description).toBe('3');
    });

    it('shows item count in group description', () => {
      registry._setItems('gh', [
        { externalId: 'issue-1', title: 'Bug A', group: 'bugs' },
        { externalId: 'issue-2', title: 'Bug B', group: 'bugs' },
        { externalId: 'issue-3', title: 'Feature C', group: 'features' }
      ]);

      const node: SourceGroupNode = { kind: 'group', providerId: 'gh', groupName: 'bugs' };
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.description).toBe('2');
    });

    it('normalizes whitespace-only groups for count computation', () => {
      registry._setItems('gh', [
        { externalId: 'issue-1', title: 'Bug A', group: 'valid' },
        { externalId: 'issue-2', title: 'Bug B', group: '   ' },
        { externalId: 'issue-3', title: 'Bug C' }
      ]);

      const validNode: SourceGroupNode = { kind: 'group', providerId: 'gh', groupName: 'valid' };
      const validTreeItem = provider.getTreeItem(validNode);
      expect(validTreeItem.description).toBe('1');
    });

    it('includes error message in tooltip for unhealthy provider', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Bug' }]);
      registry.getProviderHealth.mockReturnValue({
        status: 'unhealthy',
        lastError: 'connection refused',
        lastRefreshTime: new Date(0),
      });

      const node: SourceProviderNode = { kind: 'provider', providerId: 'gh', label: 'GitHub' };
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.tooltip).toBeInstanceOf(MarkdownString);
      const md = treeItem.tooltip as MarkdownString;
      expect(md.value).toContain('Refresh failed');
      expect(md.value).toContain('connection refused');
    });

    it('shows unhealthy provider even with zero items', () => {
      registry._setItems('gh', []);
      registry.getProviderHealth.mockReturnValue({
        status: 'unhealthy',
        lastError: 'timeout',
      });

      const children = provider.getChildren();
      expect(children).toHaveLength(1);
      expect((children[0] as SourceProviderNode).providerId).toBe('gh');
    });
  });
});
