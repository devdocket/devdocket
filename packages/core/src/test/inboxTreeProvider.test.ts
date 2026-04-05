import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter, TreeItemCollapsibleState } from 'vscode';
import { DiscoveredItem } from '../api/types';
import { InboxTreeProvider, InboxProviderNode, InboxGroupNode, InboxItem } from '../views/inboxTreeProvider';

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

describe('InboxTreeProvider', () => {
  let stateStore: ReturnType<typeof createMockStateStore>;
  let registry: ReturnType<typeof createMockProviderRegistry>;
  let provider: InboxTreeProvider;

  beforeEach(() => {
    stateStore = createMockStateStore();
    registry = createMockProviderRegistry();
    provider = new InboxTreeProvider(registry as any, stateStore as any);
  });

  function providerNode(providerId: string): InboxProviderNode {
    return { kind: 'provider', providerId, label: registry.getProviderLabel(providerId) };
  }

  describe('top-level (provider nodes)', () => {
    it('should return empty when no discovered items exist', () => {
      expect(provider.getChildren()).toEqual([]);
    });

    it('should show provider node when unseen items exist', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Bug fix' }]);

      const children = provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0].kind).toBe('provider');
      expect((children[0] as InboxProviderNode).providerId).toBe('gh');
    });

    it('should hide provider when all items are accepted', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Accepted' }]);
      stateStore._set('gh', 'issue-1', 'accepted');

      expect(provider.getChildren()).toEqual([]);
    });

    it('should hide provider when all items are dismissed', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Dismissed' }]);
      stateStore._set('gh', 'issue-1', 'dismissed');

      expect(provider.getChildren()).toEqual([]);
    });

    it('should show multiple provider nodes', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'GH item' }]);
      registry._setItems('jira', [{ externalId: '1', title: 'Jira item' }]);

      const children = provider.getChildren();
      expect(children).toHaveLength(2);
    });
  });

  describe('provider children (inbox items)', () => {
    it('should show unseen items under provider', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Bug fix' }]);

      const items = provider.getChildren(providerNode('gh'));
      expect(items).toHaveLength(1);
      expect((items[0] as InboxItem).title).toBe('Bug fix');
      expect((items[0] as InboxItem).externalId).toBe('issue-1');
    });

    it('should show items with no state (missing = unseen)', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'New item' }]);

      const items = provider.getChildren(providerNode('gh'));
      expect(items).toHaveLength(1);
    });

    it('should pass through group field from discovered item', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Bug fix', group: 'dotnet/runtime' }]);

      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'gh', groupName: 'dotnet/runtime', unseenCount: 1 };
      const items = provider.getChildren(groupNode);
      expect(items).toHaveLength(1);
      expect((items[0] as InboxItem).group).toBe('dotnet/runtime');
    });

    it('should leave group undefined when discovered item has no group', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Bug fix' }]);

      const items = provider.getChildren(providerNode('gh'));
      expect(items).toHaveLength(1);
      expect((items[0] as InboxItem).group).toBeUndefined();
    });

    it('should filter out accepted and dismissed items', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Unseen' },
        { externalId: '2', title: 'Accepted' },
        { externalId: '3', title: 'No state' },
        { externalId: '4', title: 'Dismissed' },
      ]);
      stateStore._set('gh', '2', 'accepted');
      stateStore._set('gh', '4', 'dismissed');

      const items = provider.getChildren(providerNode('gh'));
      expect(items).toHaveLength(2);
      expect(items.map((i) => (i as InboxItem).title)).toEqual(['No state', 'Unseen']);
    });
  });

  describe('group sub-grouping', () => {
    it('should group items by their group field under provider', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Issue A', group: 'repo-one' },
        { externalId: '2', title: 'Issue B', group: 'repo-one' },
        { externalId: '3', title: 'Issue C', group: 'repo-two' },
      ]);

      const children = provider.getChildren(providerNode('gh'));
      expect(children).toHaveLength(2);
      expect(children[0].kind).toBe('group');
      expect((children[0] as InboxGroupNode).groupName).toBe('repo-one');
      expect(children[1].kind).toBe('group');
      expect((children[1] as InboxGroupNode).groupName).toBe('repo-two');
    });

    it('should return items under a group node', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Issue A', group: 'repo-one' },
        { externalId: '2', title: 'Issue B', group: 'repo-one' },
        { externalId: '3', title: 'Issue C', group: 'repo-two' },
      ]);

      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'gh', groupName: 'repo-one', unseenCount: 2 };
      const items = provider.getChildren(groupNode);
      expect(items).toHaveLength(2);
      expect(items.map((i) => (i as InboxItem).title)).toEqual(['Issue A', 'Issue B']);
    });

    it('should show ungrouped items directly under provider alongside group nodes', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Grouped', group: 'repo-one' },
        { externalId: '2', title: 'Ungrouped' },
      ]);

      const children = provider.getChildren(providerNode('gh'));
      expect(children).toHaveLength(2);
      const kinds = children.map((c) => c.kind);
      expect(kinds).toContain('group');
      expect(kinds).toContain('item');
    });

    it('should sort groups and ungrouped items alphabetically', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Zebra item' },
        { externalId: '2', title: 'Issue', group: 'beta-repo' },
        { externalId: '3', title: 'Issue', group: 'alpha-repo' },
      ]);

      const children = provider.getChildren(providerNode('gh'));
      expect(children).toHaveLength(3);
      expect(children[0].kind).toBe('group');
      expect((children[0] as InboxGroupNode).groupName).toBe('alpha-repo');
      expect(children[1].kind).toBe('group');
      expect((children[1] as InboxGroupNode).groupName).toBe('beta-repo');
      expect(children[2].kind).toBe('item');
      expect((children[2] as InboxItem).title).toBe('Zebra item');
    });

    it('should filter out accepted items from groups', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Unseen', group: 'repo' },
        { externalId: '2', title: 'Accepted', group: 'repo' },
      ]);
      stateStore._set('gh', '2', 'accepted');

      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'gh', groupName: 'repo', unseenCount: 1 };
      const items = provider.getChildren(groupNode);
      expect(items).toHaveLength(1);
      expect((items[0] as InboxItem).title).toBe('Unseen');
    });

    it('should not show group node when all its items are accepted/dismissed', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Accepted', group: 'repo' },
        { externalId: '2', title: 'Ungrouped' },
      ]);
      stateStore._set('gh', '1', 'accepted');

      const children = provider.getChildren(providerNode('gh'));
      expect(children).toHaveLength(1);
      expect(children[0].kind).toBe('item');
      expect((children[0] as InboxItem).title).toBe('Ungrouped');
    });
  });

  describe('getTreeItem', () => {
    it('should render provider node with plug icon and item count', () => {
      registry._setLabel('gh', 'GitHub Issues');
      registry._setItems('gh', [
        { externalId: '1', title: 'A' },
        { externalId: '2', title: 'B' },
      ]);

      const treeItem = provider.getTreeItem(providerNode('gh'));
      expect(treeItem.label).toBe('GitHub Issues');
      expect(treeItem.description).toBe('2');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect((treeItem.iconPath as any).id).toBe('plug');
    });

    it('should render unseen inbox item with circle-filled icon', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      const treeItem = provider.getTreeItem(item);

      expect(treeItem.label).toBe('Bug');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect((treeItem.iconPath as any).id).toBe('circle-filled');
    });

    it('should render seen inbox item with circle-outline icon', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      provider.markSeen('gh', '1');
      const treeItem = provider.getTreeItem(item);

      expect(treeItem.label).toBe('Bug');
      expect((treeItem.iconPath as any).id).toBe('circle-outline');
    });

    it('should render group node with folder icon and unseen count', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'A', group: 'my-repo' },
        { externalId: '2', title: 'B', group: 'my-repo' },
      ]);

      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'gh', groupName: 'my-repo', unseenCount: 2 };
      const treeItem = provider.getTreeItem(groupNode);
      expect(treeItem.label).toBe('my-repo');
      expect(treeItem.description).toBe('2');
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect(treeItem.contextValue).toBe('inboxGroup');
      expect((treeItem.iconPath as any).id).toBe('folder');
    });

    it('should set contextValue with hasUrl when item has url', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'X', url: 'https://example.com' };
      expect(provider.getTreeItem(item).contextValue).toBe('inboxItem.hasUrl');
    });

    it('should set contextValue without hasUrl when item lacks url', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'X' };
      expect(provider.getTreeItem(item).contextValue).toBe('inboxItem');
    });
  });

  describe('markSeen', () => {
    it('should return true for a newly seen item', () => {
      expect(provider.markSeen('gh', '1')).toBe(true);
    });

    it('should return false if item is already seen', () => {
      provider.markSeen('gh', '1');
      expect(provider.markSeen('gh', '1')).toBe(false);
    });
  });

  describe('getParent', () => {
    it('should return undefined for provider nodes', () => {
      expect(provider.getParent(providerNode('gh'))).toBeUndefined();
    });

    it('should return provider node for group nodes', () => {
      registry._setLabel('gh', 'GitHub Issues');
      const groupNode: InboxGroupNode = { kind: 'group', providerId: 'gh', groupName: 'repo-one', unseenCount: 2 };
      const parent = provider.getParent(groupNode);
      expect(parent).toBeDefined();
      expect(parent!.kind).toBe('provider');
      expect((parent as InboxProviderNode).providerId).toBe('gh');
      expect((parent as InboxProviderNode).label).toBe('GitHub Issues');
    });

    it('should return group node for item with group', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Issue A', group: 'repo-one' },
        { externalId: '2', title: 'Issue B', group: 'repo-one' },
      ]);
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Issue A', group: 'repo-one' };
      const parent = provider.getParent(item);
      expect(parent).toBeDefined();
      expect(parent!.kind).toBe('group');
      expect((parent as InboxGroupNode).groupName).toBe('repo-one');
      expect((parent as InboxGroupNode).unseenCount).toBe(2);
    });

    it('should return provider node for ungrouped item', () => {
      registry._setLabel('gh', 'GitHub Issues');
      registry._setItems('gh', [{ externalId: '1', title: 'Bug fix' }]);
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug fix' };
      const parent = provider.getParent(item);
      expect(parent).toBeDefined();
      expect(parent!.kind).toBe('provider');
      expect((parent as InboxProviderNode).providerId).toBe('gh');
      expect((parent as InboxProviderNode).label).toBe('GitHub Issues');
    });
  });

  describe('events', () => {
    it('should refresh when providerRegistry fires change event', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      registry._fire();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should retain seenItems for items still in inbox after provider refresh', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'Bug' }]);
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      provider.markSeen('gh', '1');

      // Before refresh, item should be seen (circle-outline icon)
      expect(provider.getTreeItem(item).label).toBe('Bug');
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('circle-outline');

      // Provider refresh fires → item is still in inbox, so seenItems should be retained
      registry._fire();

      // After refresh, item should still appear as seen (circle-outline icon)
      expect(provider.getTreeItem(item).label).toBe('Bug');
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('circle-outline');
    });

    it('should prune seenItems for items no longer in inbox after provider refresh', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'Bug' }]);
      provider.markSeen('gh', '1');

      // Remove item from provider
      registry._setItems('gh', []);
      registry._fire();

      // Re-add item — should appear as unseen (circle-filled icon)
      registry._setItems('gh', [{ externalId: '1', title: 'Bug' }]);
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      expect(provider.getTreeItem(item).label).toBe('Bug');
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('circle-filled');
    });

    it('should refresh when stateStore fires change event', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      stateStore._fire();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should prune seenItems after state changes make item no longer unseen', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'Bug' }]);
      provider.markSeen('gh', '1');

      // Item is seen → circle-outline
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('circle-outline');

      // Accept it via stateStore, then fire change → prune runs
      stateStore._set('gh', '1', 'accepted');
      stateStore._fire();

      // Re-add as unseen later — should be fresh (circle-filled)
      stateStore._set('gh', '1', 'unseen');
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('circle-filled');
    });

    it('should clean up event listeners after dispose', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      provider.dispose();

      // Firing events after dispose should not reach listener
      registry._fire();
      stateStore._fire();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('getTreeItem tooltip', () => {
    it('should include title and description in tooltip', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug fix', description: 'Fix the crash on startup' };
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.tooltip).toBeDefined();
      expect(treeItem.tooltip.value).toContain('Bug fix');
      expect(treeItem.tooltip.value).toContain('Fix the crash on startup');
    });

    it('should only include title when item has no description', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug fix' };
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.tooltip).toBeDefined();
      expect(treeItem.tooltip.value).toContain('Bug fix');
      // Should not contain extra content beyond the title
      const afterTitle = treeItem.tooltip.value.replace(/\*\*Bug fix\*\*/, '').trim();
      expect(afterTitle).toBe('');
    });
  });

  describe('getChildren for item node', () => {
    it('should return empty array for item nodes (no children)', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      expect(provider.getChildren(item)).toEqual([]);
    });
  });

  describe('provider count accuracy', () => {
    it('should show correct unseen count after some items become accepted', () => {
      registry._setLabel('gh', 'GitHub');
      registry._setItems('gh', [
        { externalId: '1', title: 'A' },
        { externalId: '2', title: 'B' },
        { externalId: '3', title: 'C' },
        { externalId: '4', title: 'D' },
      ]);
      stateStore._set('gh', '2', 'accepted');
      stateStore._set('gh', '4', 'dismissed');

      const treeItem = provider.getTreeItem(providerNode('gh'));
      expect(treeItem.description).toBe('2');
    });
  });

  describe('markSeen across providers', () => {
    it('should track seen items independently per provider', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'GH Issue' }]);
      registry._setItems('jira', [{ externalId: '1', title: 'Jira Ticket' }]);

      provider.markSeen('gh', '1');

      const ghItem: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'GH Issue' };
      const jiraItem: InboxItem = { kind: 'item', providerId: 'jira', externalId: '1', title: 'Jira Ticket' };

      // GH item is seen
      expect((provider.getTreeItem(ghItem).iconPath as any).id).toBe('circle-outline');
      // Jira item with same externalId is NOT seen
      expect((provider.getTreeItem(jiraItem).iconPath as any).id).toBe('circle-filled');
    });

    it('should allow marking items from multiple providers as seen', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'GH' }]);
      registry._setItems('jira', [{ externalId: '2', title: 'Jira' }]);
      registry._setItems('ado', [{ externalId: '3', title: 'ADO' }]);

      expect(provider.markSeen('gh', '1')).toBe(true);
      expect(provider.markSeen('jira', '2')).toBe(true);
      expect(provider.markSeen('ado', '3')).toBe(true);

      const ghItem: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'GH' };
      const jiraItem: InboxItem = { kind: 'item', providerId: 'jira', externalId: '2', title: 'Jira' };
      const adoItem: InboxItem = { kind: 'item', providerId: 'ado', externalId: '3', title: 'ADO' };

      expect((provider.getTreeItem(ghItem).iconPath as any).id).toBe('circle-outline');
      expect((provider.getTreeItem(jiraItem).iconPath as any).id).toBe('circle-outline');
      expect((provider.getTreeItem(adoItem).iconPath as any).id).toBe('circle-outline');
    });
  });

  describe('large number of items', () => {
    it('should handle 50+ items across multiple groups with correct counts and sorting', () => {
      const items: { externalId: string; title: string; group?: string }[] = [];
      // 20 items in group "alpha"
      for (let i = 0; i < 20; i++) {
        items.push({ externalId: `a-${i}`, title: `Alpha ${String(i).padStart(2, '0')}`, group: 'alpha' });
      }
      // 20 items in group "beta"
      for (let i = 0; i < 20; i++) {
        items.push({ externalId: `b-${i}`, title: `Beta ${String(i).padStart(2, '0')}`, group: 'beta' });
      }
      // 15 ungrouped items
      for (let i = 0; i < 15; i++) {
        items.push({ externalId: `u-${i}`, title: `Ungrouped ${String(i).padStart(2, '0')}` });
      }

      registry._setLabel('gh', 'GitHub');
      registry._setItems('gh', items);

      // Accept some items
      stateStore._set('gh', 'a-0', 'accepted');
      stateStore._set('gh', 'a-1', 'dismissed');
      stateStore._set('gh', 'b-5', 'accepted');

      // Provider-level count should be 55 total - 3 accepted/dismissed = 52
      const providerTreeItem = provider.getTreeItem(providerNode('gh'));
      expect(providerTreeItem.description).toBe('52');

      // Provider children: 2 groups + 15 ungrouped items = 17 entries
      const children = provider.getChildren(providerNode('gh'));
      expect(children).toHaveLength(17);

      // Groups should come first (alphabetically), then ungrouped items
      expect(children[0].kind).toBe('group');
      expect((children[0] as InboxGroupNode).groupName).toBe('alpha');
      expect((children[0] as InboxGroupNode).unseenCount).toBe(18); // 20 - 2

      expect(children[1].kind).toBe('group');
      expect((children[1] as InboxGroupNode).groupName).toBe('beta');
      expect((children[1] as InboxGroupNode).unseenCount).toBe(19); // 20 - 1

      // Remaining 15 are ungrouped items, sorted alphabetically
      for (let i = 2; i < 17; i++) {
        expect(children[i].kind).toBe('item');
      }
      expect((children[2] as InboxItem).title).toBe('Ungrouped 00');
      expect((children[16] as InboxItem).title).toBe('Ungrouped 14');

      // Alpha group children: 18 unseen items, sorted
      const alphaGroup: InboxGroupNode = { kind: 'group', providerId: 'gh', groupName: 'alpha', unseenCount: 18 };
      const alphaChildren = provider.getChildren(alphaGroup);
      expect(alphaChildren).toHaveLength(18);
      expect((alphaChildren[0] as InboxItem).title).toBe('Alpha 02'); // 00 and 01 were accepted/dismissed

      // Beta group children: 19 unseen items
      const betaGroup: InboxGroupNode = { kind: 'group', providerId: 'gh', groupName: 'beta', unseenCount: 19 };
      const betaChildren = provider.getChildren(betaGroup);
      expect(betaChildren).toHaveLength(19);
    });

    it('should handle items from many providers', () => {
      // Create 5 providers with 10+ items each
      for (let p = 0; p < 5; p++) {
        const providerId = `provider-${p}`;
        registry._setLabel(providerId, `Provider ${p}`);
        const providerItems: { externalId: string; title: string }[] = [];
        for (let i = 0; i < 12; i++) {
          providerItems.push({ externalId: `item-${i}`, title: `Item ${String(i).padStart(2, '0')}` });
        }
        registry._setItems(providerId, providerItems);
      }

      // Top-level should show 5 providers, sorted by label
      const topLevel = provider.getChildren();
      expect(topLevel).toHaveLength(5);
      expect((topLevel[0] as InboxProviderNode).label).toBe('Provider 0');
      expect((topLevel[4] as InboxProviderNode).label).toBe('Provider 4');

      // Each provider should report 12 items
      for (const node of topLevel) {
        const treeItem = provider.getTreeItem(node);
        expect(treeItem.description).toBe('12');
      }
    });
  });
});
