import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter, MarkdownString, TreeItemCollapsibleState } from 'vscode';
import { DiscoveredItem } from '../api/types';
import { InboxTreeProvider, InboxProviderNode, InboxGroupNode, InboxItem } from '../views/inboxTreeProvider';

const DEBOUNCE_MS = InboxTreeProvider.REFRESH_DEBOUNCE_MS;

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
    prune: vi.fn(async () => 0),
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
  let _loading = false;
  return {
    get loading() { return _loading; },
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
    _setLoading: (val: boolean) => { _loading = val; },
    _fire: () => emitter.fire(),
  };
}

function createMockReadStateStore() {
  const items = new Set<string>();
  return {
    has: vi.fn((key: string) => items.has(key)),
    add: vi.fn(async (key: string) => {
      if (items.has(key)) { return false; }
      items.add(key);
      return true;
    }),
    addMany: vi.fn(async (keys: string[]) => {
      const added: string[] = [];
      for (const key of keys) {
        if (!items.has(key)) {
          items.add(key);
          added.push(key);
        }
      }
      return added;
    }),
    deleteMany: vi.fn(async (keys: string[]) => {
      for (const key of keys) { items.delete(key); }
    }),
    keys: vi.fn(() => items.values()),
    load: vi.fn(async () => {}),
    _add: (key: string) => { items.add(key); },
  };
}

describe('InboxTreeProvider', () => {
  let stateStore: ReturnType<typeof createMockStateStore>;
  let readStateStore: ReturnType<typeof createMockReadStateStore>;
  let registry: ReturnType<typeof createMockProviderRegistry>;
  let provider: InboxTreeProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    stateStore = createMockStateStore();
    readStateStore = createMockReadStateStore();
    registry = createMockProviderRegistry();
    provider = new InboxTreeProvider(registry as any, stateStore as any, readStateStore as any);
  });

  afterEach(() => {
    provider.dispose();
    vi.useRealTimers();
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

    it('nests related inbox items under their parent item', () => {
      registry._setItems('github-my-prs', [{
        externalId: 'owner/repo#42',
        title: 'PR 42',
        relatedItems: [{ externalId: 'owner/repo#7', relation: 'closes' }],
      }]);
      registry._setItems('github', [{ externalId: 'owner/repo#7', title: 'Issue 7' }]);

      const parentItems = provider.getChildren(providerNode('github-my-prs')) as InboxItem[];
      expect(parentItems).toHaveLength(1);
      const linkedChildren = provider.getChildren(parentItems[0]) as InboxItem[];

      expect(linkedChildren).toHaveLength(1);
      expect(linkedChildren[0].externalId).toBe('owner/repo#7');
      expect(provider.getTreeItem(parentItems[0]).collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect(provider.getTreeItem(linkedChildren[0]).description).toBe('Closes #42');
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

    it('should trim whitespace from group names when grouping', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Issue A', group: ' repo-one ' },
        { externalId: '2', title: 'Issue B', group: 'repo-one' },
      ]);

      const children = provider.getChildren(providerNode('gh'));
      expect(children).toHaveLength(1);
      expect(children[0].kind).toBe('group');
      expect((children[0] as InboxGroupNode).groupName).toBe('repo-one');
      expect((children[0] as InboxGroupNode).unseenCount).toBe(2);
    });

    it('should treat whitespace-only group as ungrouped', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Whitespace', group: '  ' },
        { externalId: '2', title: 'Normal', group: 'repo' },
      ]);

      const children = provider.getChildren(providerNode('gh'));
      expect(children).toHaveLength(2);
      const group = children.find(c => c.kind === 'group') as InboxGroupNode;
      const item = children.find(c => c.kind === 'item') as InboxItem;
      expect(group.groupName).toBe('repo');
      expect(item.title).toBe('Whitespace');
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

    it('should render seen inbox item with circle-outline icon', async () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      await provider.markSeen('gh', '1');
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

    it('should set description to group and provider label in flat layout', () => {
      provider.layout = 'flat';
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug', group: 'octocat/repo' };
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.description).toBe('octocat/repo · gh');
    });

    it('should show undefined description in tree layout', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug', group: 'octocat/repo' };
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.description).toBeUndefined();
    });

    it('should set description to provider label in flat layout when no group', () => {
      provider.layout = 'flat';
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.description).toBe('gh');
    });

    it('should set contextValue with hasUrl when item has url', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'X', url: 'https://example.com' };
      expect(provider.getTreeItem(item).contextValue).toBe('inboxItem.hasUrl');
    });

    it('should set contextValue without hasUrl when item lacks url', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'X' };
      expect(provider.getTreeItem(item).contextValue).toBe('inboxItem');
    });

    it('should include reason in tooltip when item has reason', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug', reason: 'review_requested' };
      const treeItem = provider.getTreeItem(item);
      const tooltip = treeItem.tooltip as any;
      expect(tooltip.value).toContain('Reason: Review requested');
    });

    it('should not include reason in tooltip when item has no reason', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      const treeItem = provider.getTreeItem(item);
      const tooltip = treeItem.tooltip as any;
      expect(tooltip.value).not.toContain('Reason');
    });
  });

  describe('markSeen', () => {
    it('should return true for a newly seen item', async () => {
      expect(await provider.markSeen('gh', '1')).toBe(true);
    });

    it('should return false if item is already seen', async () => {
      await provider.markSeen('gh', '1');
      expect(await provider.markSeen('gh', '1')).toBe(false);
    });

    it('should fire onDidMarkSeen when a new item is marked seen', async () => {
      const listener = vi.fn();
      provider.onDidMarkSeen(listener);
      await provider.markSeen('gh', '1');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should not fire onDidMarkSeen when item is already seen', async () => {
      await provider.markSeen('gh', '1');
      const listener = vi.fn();
      provider.onDidMarkSeen(listener);
      await provider.markSeen('gh', '1');
      expect(listener).not.toHaveBeenCalled();
    });

    it('should expose seen items via sessionSeenItems', async () => {
      expect(provider.sessionSeenItems.size).toBe(0);
      await provider.markSeen('gh', '1');
      expect(provider.sessionSeenItems.has('gh::1')).toBe(true);
      expect(provider.sessionSeenItems.size).toBe(1);
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
      vi.advanceTimersByTime(DEBOUNCE_MS);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should retain seenItems for items still in inbox after provider refresh', async () => {
      registry._setItems('gh', [{ externalId: '1', title: 'Bug' }]);
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      await provider.markSeen('gh', '1');

      // Before refresh, item should be seen (circle-outline icon)
      expect(provider.getTreeItem(item).label).toBe('Bug');
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('circle-outline');

      // Provider refresh fires → item is still in inbox, so seenItems should be retained
      registry._fire();
      vi.advanceTimersByTime(DEBOUNCE_MS);

      // After refresh, item should still appear as seen (circle-outline icon)
      expect(provider.getTreeItem(item).label).toBe('Bug');
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('circle-outline');
    });

    it('should prune seenItems for items no longer in inbox after provider refresh', async () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Bug' },
        { externalId: '2', title: 'Feature' },
      ]);
      await provider.markSeen('gh', '1');

      // Replace items — item '1' is gone, item '2' remains
      registry._setItems('gh', [{ externalId: '2', title: 'Feature' }]);
      registry._fire();
      vi.advanceTimersByTime(DEBOUNCE_MS);

      // Re-add item '1' — should appear as unseen since it was pruned
      registry._setItems('gh', [
        { externalId: '1', title: 'Bug' },
        { externalId: '2', title: 'Feature' },
      ]);
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      expect(provider.getTreeItem(item).label).toBe('Bug');
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('circle-filled');
    });

    it('should refresh when stateStore fires change event', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      stateStore._fire();
      vi.advanceTimersByTime(DEBOUNCE_MS);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should coalesce multiple rapid events into a single refresh', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      registry._fire();
      registry._fire();
      stateStore._fire();
      vi.advanceTimersByTime(DEBOUNCE_MS);
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
      vi.advanceTimersByTime(DEBOUNCE_MS);

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

    it('should skip pruning seenItems while providers are loading', async () => {
      registry._setItems('gh', [{ externalId: '1', title: 'Bug' }]);
      await provider.markSeen('gh', '1');

      // Simulate provider re-registration: items temporarily empty, loading=true
      registry._setItems('gh', []);
      registry._setLoading(true);
      registry._fire();

      // After loading completes, items come back
      registry._setItems('gh', [{ externalId: '1', title: 'Bug' }]);
      registry._setLoading(false);
      registry._fire();

      // Item should still be seen because pruning was skipped while loading
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      expect((provider.getTreeItem(item).iconPath as any).id).toBe('circle-outline');
    });

    it('should call stateStore.prune during debounced refresh', async () => {
      registry._setItems('gh', [{ externalId: '1', title: 'Bug' }]);
      registry._fire();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(stateStore.prune).toHaveBeenCalledWith(registry.getAllDiscoveredItems());
    });

    it('should skip stateStore.prune while providers are loading', async () => {
      registry._setItems('gh', [{ externalId: '1', title: 'Bug' }]);
      registry._setLoading(true);
      registry._fire();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(stateStore.prune).not.toHaveBeenCalled();
    });
  });

  describe('getTreeItem tooltip', () => {
    it('should include title in tooltip but not description', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug fix', description: 'Fix the crash on startup' };
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.tooltip).toBeInstanceOf(MarkdownString);
      const tooltip = treeItem.tooltip as MarkdownString;
      expect(tooltip.value).toContain('Bug fix');
      expect(tooltip.value).not.toContain('Fix the crash on startup');
    });

    it('should only include title when item has no description', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug fix' };
      const treeItem = provider.getTreeItem(item);
      expect(treeItem.tooltip).toBeInstanceOf(MarkdownString);
      const tooltip = treeItem.tooltip as MarkdownString;
      expect(tooltip.value).toContain('Bug fix');
      // Should not contain extra content beyond the title label
      const afterTitle = tooltip.value.replace(/\*\*Title:\*\* /, '').replace('Bug fix', '').trim();
      expect(afterTitle).toBe('');
    });

    it('uses appendText for title to prevent markdown injection', () => {
      const maliciousTitle = '[Click me](command:workbench.action.terminal.sendSequence)';
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: maliciousTitle };

      const appendTextSpy = vi.spyOn(MarkdownString.prototype, 'appendText');
      const appendMarkdownSpy = vi.spyOn(MarkdownString.prototype, 'appendMarkdown');

      provider.getTreeItem(item);

      const textCalls = appendTextSpy.mock.calls.map(c => c[0]);
      const mdCalls = appendMarkdownSpy.mock.calls.map(c => c[0]);

      expect(textCalls).toContainEqual(maliciousTitle);
      expect(mdCalls).not.toContainEqual(maliciousTitle);

      appendTextSpy.mockRestore();
      appendMarkdownSpy.mockRestore();
    });

    it('does not render description in tooltip', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Safe', description: 'Some description' };

      const treeItem = provider.getTreeItem(item);
      const tooltip = treeItem.tooltip as MarkdownString;

      expect(tooltip.value).not.toContain('Some description');
    });

    it('uses appendText for reason to prevent markdown injection', () => {
      const maliciousReason = '[evil](command:exec)';
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Safe', reason: maliciousReason };

      const appendTextSpy = vi.spyOn(MarkdownString.prototype, 'appendText');
      const appendMarkdownSpy = vi.spyOn(MarkdownString.prototype, 'appendMarkdown');

      provider.getTreeItem(item);

      const textCalls = appendTextSpy.mock.calls.map(c => c[0]);
      const mdCalls = appendMarkdownSpy.mock.calls.map(c => c[0]);

      const formattedReason = maliciousReason.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
      expect(textCalls).toContainEqual(formattedReason);
      expect(mdCalls).not.toContainEqual(formattedReason);

      appendTextSpy.mockRestore();
      appendMarkdownSpy.mockRestore();
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

    it('should allow marking items from multiple providers as seen', async () => {
      registry._setItems('gh', [{ externalId: '1', title: 'GH' }]);
      registry._setItems('jira', [{ externalId: '2', title: 'Jira' }]);
      registry._setItems('ado', [{ externalId: '3', title: 'ADO' }]);

      expect(await provider.markSeen('gh', '1')).toBe(true);
      expect(await provider.markSeen('jira', '2')).toBe(true);
      expect(await provider.markSeen('ado', '3')).toBe(true);

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

  describe('unhealthy provider rendering', () => {
    it('shows warning icon for unhealthy provider', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Bug' }]);
      registry.getProviderHealth.mockReturnValue({
        status: 'unhealthy',
        lastError: 'network error',
        lastRefreshTime: new Date(0),
      });

      const node = providerNode('gh');
      const treeItem = provider.getTreeItem(node);
      expect((treeItem.iconPath as any).id).toBe('warning');
    });

    it('shows plug icon for healthy provider', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Bug' }]);
      registry.getProviderHealth.mockReturnValue({
        status: 'healthy',
        lastRefreshTime: new Date(),
      });

      const node = providerNode('gh');
      const treeItem = provider.getTreeItem(node);
      expect((treeItem.iconPath as any).id).toBe('plug');
    });

    it('includes error message in tooltip for unhealthy provider', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Bug' }]);
      registry.getProviderHealth.mockReturnValue({
        status: 'unhealthy',
        lastError: 'connection refused',
        lastRefreshTime: new Date(0),
      });

      const node = providerNode('gh');
      const treeItem = provider.getTreeItem(node);
      expect(treeItem.tooltip).toBeInstanceOf(MarkdownString);
      const md = treeItem.tooltip as MarkdownString;
      expect(md.value).toContain('Refresh failed');
      expect(md.value).toContain('connection refused');
    });

    it('shows unhealthy provider even with zero unseen items', () => {
      registry._setItems('gh', [{ externalId: 'issue-1', title: 'Bug' }]);
      stateStore._set('gh', 'issue-1', 'accepted');
      registry.getProviderHealth.mockReturnValue({
        status: 'unhealthy',
        lastError: 'timeout',
      });

      const children = provider.getChildren();
      expect(children).toHaveLength(1);
      expect((children[0] as InboxProviderNode).providerId).toBe('gh');
    });
  });

  describe('canonicalId dedup', () => {
    it('shows only one representative when items share canonicalId across providers', () => {
      registry._setItems('prs', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      registry._setItems('reviews', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);

      // Flat mode shows all unseen items
      provider.layout = 'flat';
      const items = provider.getChildren();
      expect(items).toHaveLength(1);
      // Representative is the first by sorted key
      const item = items[0] as InboxItem;
      expect(item.kind).toBe('item');
    });

    it('shows items without canonicalId individually', () => {
      registry._setItems('prs', [
        { externalId: 'repo#1', title: 'PR #1' },
      ]);
      registry._setItems('reviews', [
        { externalId: 'repo#1', title: 'Review #1' },
      ]);

      provider.layout = 'flat';
      const items = provider.getChildren();
      expect(items).toHaveLength(2);
    });

    it('hides duplicates in tree mode provider children', () => {
      registry._setLabel('prs', 'My PRs');
      registry._setLabel('reviews', 'PR Reviews');
      registry._setItems('prs', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      registry._setItems('reviews', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);

      // Tree mode: only one provider should have unseen items
      const topLevel = provider.getChildren();
      // One provider's items are hidden, so only one provider node appears
      expect(topLevel).toHaveLength(1);
    });

    it('deterministic representative selection (sorted by key)', () => {
      // 'alpha' provider key comes before 'beta'
      registry._setItems('beta', [
        { externalId: 'x#1', title: 'From beta', canonicalId: 'shared:x#1' },
      ]);
      registry._setItems('alpha', [
        { externalId: 'x#1', title: 'From alpha', canonicalId: 'shared:x#1' },
      ]);

      provider.layout = 'flat';
      const items = provider.getChildren();
      expect(items).toHaveLength(1);
      const representative = items[0] as InboxItem;
      // alpha::x#1 < beta::x#1
      expect(representative.providerId).toBe('alpha');
    });

    it('does not dedup items with different canonicalIds', () => {
      registry._setItems('prs', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
        { externalId: 'repo#2', title: 'PR #2', canonicalId: 'github:pull:repo#2' },
      ]);

      provider.layout = 'flat';
      const items = provider.getChildren();
      expect(items).toHaveLength(2);
    });

    it('dedup respects accepted/dismissed state', () => {
      registry._setItems('prs', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      registry._setItems('reviews', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      // Accept one of them
      stateStore._set('prs', 'repo#1', 'accepted');

      provider.layout = 'flat';
      const items = provider.getChildren();
      // Only the reviews item remains since the prs one is accepted
      expect(items).toHaveLength(1);
      expect((items[0] as InboxItem).providerId).toBe('reviews');
    });

    it('dedup correctly counts unseen items per provider', () => {
      registry._setLabel('prs', 'My PRs');
      registry._setLabel('reviews', 'PR Reviews');
      registry._setItems('prs', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
        { externalId: 'repo#2', title: 'PR #2' },
      ]);
      registry._setItems('reviews', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);

      // prs provider: repo#1 is representative (prs::repo#1 < reviews::repo#1), repo#2 no canonicalId
      const prsTreeItem = provider.getTreeItem(providerNode('prs'));
      expect(prsTreeItem.description).toBe('2');

      // reviews provider: repo#1 is hidden (reviews::repo#1 > prs::repo#1)
      const reviewsTreeItem = provider.getTreeItem(providerNode('reviews'));
      expect(reviewsTreeItem.description).toBe('0');
    });

    it('dedup with groups hides items correctly', () => {
      registry._setItems('prs', [
        { externalId: 'repo#1', title: 'PR #1', group: 'myrepo', canonicalId: 'github:pull:repo#1' },
      ]);
      registry._setItems('reviews', [
        { externalId: 'repo#1', title: 'PR #1', group: 'myrepo', canonicalId: 'github:pull:repo#1' },
      ]);

      const prsChildren = provider.getChildren(providerNode('prs'));
      // prs is the representative (prs < reviews alphabetically)
      expect(prsChildren.length).toBeGreaterThan(0);

      const reviewsChildren = provider.getChildren(providerNode('reviews'));
      expect(reviewsChildren).toHaveLength(0);
    });

    it('markSeen propagates to canonical peers', async () => {
      registry._setItems('prs', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      registry._setItems('reviews', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);

      await provider.markSeen('prs', 'repo#1');

      // Both should now be seen
      expect(provider.sessionSeenItems.has('prs::repo#1')).toBe(true);
      expect(provider.sessionSeenItems.has('reviews::repo#1')).toBe(true);
    });

    it('markSeenBatch propagates to canonical peers', async () => {
      registry._setItems('prs', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      registry._setItems('reviews', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);

      await provider.markSeenBatch([{ providerId: 'prs', externalId: 'repo#1' }]);

      expect(provider.sessionSeenItems.has('prs::repo#1')).toBe(true);
      expect(provider.sessionSeenItems.has('reviews::repo#1')).toBe(true);
    });

    it('markSeen does not propagate to already-accepted canonical peers', async () => {
      registry._setItems('prs', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      registry._setItems('reviews', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      stateStore._set('reviews', 'repo#1', 'accepted');

      await provider.markSeen('prs', 'repo#1');

      expect(provider.sessionSeenItems.has('prs::repo#1')).toBe(true);
      // Peer is already accepted — should not be marked seen
      expect(provider.sessionSeenItems.has('reviews::repo#1')).toBe(false);
    });

    it('markSeenBatch does not propagate to already-dismissed canonical peers', async () => {
      registry._setItems('prs', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      registry._setItems('reviews', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      stateStore._set('reviews', 'repo#1', 'dismissed');

      await provider.markSeenBatch([{ providerId: 'prs', externalId: 'repo#1' }]);

      expect(provider.sessionSeenItems.has('prs::repo#1')).toBe(true);
      // Peer is already dismissed — should not be marked seen
      expect(provider.sessionSeenItems.has('reviews::repo#1')).toBe(false);
    });

    it('tree item isSeen reflects canonical peer read state', async () => {
      registry._setItems('prs', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);
      registry._setItems('reviews', [
        { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      ]);

      // Mark one peer as read
      readStateStore._add('reviews::repo#1');

      // The representative (prs::repo#1) should show as seen because its canonical peer is read
      const items = provider.getChildren(providerNode('prs')) as InboxItem[];
      expect(items).toHaveLength(1);
      const treeItem = provider.getTreeItem(items[0]);
      expect(treeItem.iconPath).toEqual(expect.objectContaining({ id: 'circle-outline' }));
    });
  });
});
