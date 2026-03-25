import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter, TreeItemCollapsibleState, ThemeIcon } from 'vscode';
import { DiscoveredItem } from '../api/types';
import { InboxTreeProvider, InboxProviderNode, InboxItem } from '../views/inboxTreeProvider';

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
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
      expect((treeItem.iconPath as any).id).toBe('plug');
    });

    it('should render new inbox item with highlighted label', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      const treeItem = provider.getTreeItem(item);

      expect(treeItem.label).toEqual({ label: 'Bug', highlights: [[0, 3]] });
      expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.None);
      expect((treeItem.iconPath as any).id).toBe('mail');
    });

    it('should render seen inbox item with plain label', () => {
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      provider.markSeen('gh', '1');
      const treeItem = provider.getTreeItem(item);

      expect(treeItem.label).toBe('Bug');
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

      // Before refresh, item should be seen (plain label)
      expect(provider.getTreeItem(item).label).toBe('Bug');

      // Provider refresh fires → item is still in inbox, so seenItems should be retained
      registry._fire();

      // After refresh, item should still appear as seen (plain label)
      expect(provider.getTreeItem(item).label).toBe('Bug');
    });

    it('should prune seenItems for items no longer in inbox after provider refresh', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'Bug' }]);
      provider.markSeen('gh', '1');

      // Remove item from provider
      registry._setItems('gh', []);
      registry._fire();

      // Re-add item — should appear as unseen (highlighted)
      registry._setItems('gh', [{ externalId: '1', title: 'Bug' }]);
      const item: InboxItem = { kind: 'item', providerId: 'gh', externalId: '1', title: 'Bug' };
      expect(provider.getTreeItem(item).label).toEqual({ label: 'Bug', highlights: [[0, 3]] });
    });

    it('should refresh when stateStore fires change event', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      stateStore._fire();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
