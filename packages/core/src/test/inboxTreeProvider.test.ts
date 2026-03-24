import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter, TreeItemCollapsibleState, ThemeIcon } from 'vscode';
import { DiscoveredItem } from '../api/types';
import { InboxTreeProvider } from '../views/inboxTreeProvider';

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

  it('should return empty when no discovered items exist', () => {
    const children = provider.getChildren();
    expect(children).toEqual([]);
  });

  it('should show items with unseen state', () => {
    registry._setItems('gh', [
      { externalId: 'issue-1', title: 'Bug fix' },
    ]);
    stateStore.getState.mockReturnValue('unseen');

    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0].title).toBe('Bug fix');
    expect(children[0].externalId).toBe('issue-1');
    expect(children[0].providerId).toBe('gh');
  });

  it('should show items with no state entry (missing = unseen)', () => {
    registry._setItems('gh', [
      { externalId: 'issue-1', title: 'New item' },
    ]);
    stateStore.getState.mockReturnValue(undefined);

    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0].title).toBe('New item');
  });

  it('should hide items with accepted state', () => {
    registry._setItems('gh', [
      { externalId: 'issue-1', title: 'Accepted item' },
    ]);
    stateStore.getState.mockReturnValue('accepted');

    const children = provider.getChildren();
    expect(children).toEqual([]);
  });

  it('should hide items with dismissed state', () => {
    registry._setItems('gh', [
      { externalId: 'issue-1', title: 'Dismissed item' },
    ]);
    stateStore.getState.mockReturnValue('dismissed');

    const children = provider.getChildren();
    expect(children).toEqual([]);
  });

  it('should show mixed items — only unseen and undefined state', () => {
    registry._setItems('gh', [
      { externalId: 'issue-1', title: 'Unseen' },
      { externalId: 'issue-2', title: 'Accepted' },
      { externalId: 'issue-3', title: 'No state' },
      { externalId: 'issue-4', title: 'Dismissed' },
    ]);
    stateStore.getState
      .mockReturnValueOnce('unseen')
      .mockReturnValueOnce('accepted')
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce('dismissed');

    const children = provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.title)).toEqual(['Unseen', 'No state']);
  });

  it('should return correct treeItem with label and description', () => {
    registry._setLabel('gh', 'GitHub Issues');
    registry._setItems('gh', [
      { externalId: 'issue-1', title: 'Bug fix', description: 'Fix the bug', url: 'https://example.com' },
    ]);

    const children = provider.getChildren();
    const treeItem = provider.getTreeItem(children[0]);

    expect(treeItem.label).toBe('Bug fix');
    expect(treeItem.description).toBe('GitHub Issues');
    expect(treeItem.collapsibleState).toBe(TreeItemCollapsibleState.None);
  });

  it('should use mail icon for inbox items', () => {
    registry._setItems('gh', [
      { externalId: 'issue-1', title: 'Item' },
    ]);

    const children = provider.getChildren();
    const treeItem = provider.getTreeItem(children[0]);

    expect(treeItem.iconPath).toBeInstanceOf(ThemeIcon);
    expect((treeItem.iconPath as any).id).toBe('mail');
  });

  it('should set contextValue with hasUrl when item has url', () => {
    registry._setItems('gh', [
      { externalId: 'issue-1', title: 'With URL', url: 'https://example.com' },
    ]);

    const children = provider.getChildren();
    const treeItem = provider.getTreeItem(children[0]);
    expect(treeItem.contextValue).toBe('inboxItem.hasUrl');
  });

  it('should set contextValue without hasUrl when item lacks url', () => {
    registry._setItems('gh', [
      { externalId: 'issue-1', title: 'No URL' },
    ]);

    const children = provider.getChildren();
    const treeItem = provider.getTreeItem(children[0]);
    expect(treeItem.contextValue).toBe('inboxItem');
  });

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

  it('should aggregate items from multiple providers', () => {
    registry._setItems('gh', [
      { externalId: 'issue-1', title: 'GH item' },
    ]);
    registry._setItems('jira', [
      { externalId: 'task-1', title: 'Jira item' },
    ]);

    const children = provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.providerId)).toEqual(['gh', 'jira']);
  });
});
