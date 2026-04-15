import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'vscode';
import { DiscoveredItem } from '../api/types';
import { InboxTreeProvider, InboxItem } from '../views/inboxTreeProvider';

function createMockStateStore() {
  const states = new Map<string, string>();
  const emitter = new EventEmitter<void>();
  return {
    getState: vi.fn((pid: string, eid: string) => states.get(`${pid}::${eid}`) as any),
    setState: vi.fn(),
    setStates: vi.fn(),
    onDidChange: emitter.event,
    _set: (pid: string, eid: string, s: string) => states.set(`${pid}::${eid}`, s),
    _fire: () => emitter.fire(),
  };
}

function createMockReadStateStore() {
  const keys = new Set<string>();
  return {
    has: vi.fn((key: string) => keys.has(key)),
    add: vi.fn(async (key: string) => { keys.add(key); return true; }),
    deleteMany: vi.fn(async () => {}),
    load: vi.fn(async () => {}),
    keys: vi.fn(() => keys.values()),
  };
}

function createMockProviderRegistry() {
  const items = new Map<string, DiscoveredItem[]>();
  const labels = new Map<string, string>();
  const emitter = new EventEmitter<void>();
  const healthEmitter = new EventEmitter<string>();
  return {
    loading: false,
    getAllDiscoveredItems: vi.fn(() => items),
    getDiscoveredItems: vi.fn((id: string) => items.get(id) ?? []),
    getProviderLabel: vi.fn((id: string) => labels.get(id) ?? id),
    getProviderHealth: vi.fn(() => ({ status: 'unknown' as const })),
    onDidChangeDiscoveredItems: emitter.event,
    onDidChangeProviderHealth: healthEmitter.event,
    _setItems: (pid: string, list: DiscoveredItem[]) => { items.set(pid, list); },
    _setLabel: (pid: string, label: string) => { labels.set(pid, label); },
    _fire: () => emitter.fire(),
  };
}

describe('InboxTreeProvider layout toggle', () => {
  let registry: ReturnType<typeof createMockProviderRegistry>;
  let stateStore: ReturnType<typeof createMockStateStore>;
  let readStateStore: ReturnType<typeof createMockReadStateStore>;
  let provider: InboxTreeProvider;

  beforeEach(() => {
    registry = createMockProviderRegistry();
    stateStore = createMockStateStore();
    readStateStore = createMockReadStateStore();
    provider = new InboxTreeProvider(registry as any, stateStore as any, readStateStore as any);
  });

  it('defaults to tree layout', () => {
    expect(provider.layout).toBe('tree');
  });

  it('fires tree data change when layout changes', () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.layout = 'flat';
    expect(listener).toHaveBeenCalledTimes(1);
  });

  describe('tree mode (default)', () => {
    it('returns provider nodes at top level', () => {
      registry._setLabel('gh', 'GitHub');
      registry._setItems('gh', [
        { externalId: '1', title: 'Issue #1' },
        { externalId: '2', title: 'Issue #2' },
      ]);
      const children = provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0].kind).toBe('provider');
    });
  });

  describe('flat mode', () => {
    beforeEach(() => {
      provider.layout = 'flat';
    });

    it('returns all unseen items directly without hierarchy', () => {
      registry._setLabel('gh', 'GitHub');
      registry._setItems('gh', [
        { externalId: '1', title: 'Issue #1', group: 'repo-a' },
        { externalId: '2', title: 'Issue #2', group: 'repo-b' },
      ]);
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.every(c => c.kind === 'item')).toBe(true);
    });

    it('sorts items alphabetically by title', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Zebra' },
        { externalId: '2', title: 'Alpha' },
      ]);
      const children = provider.getChildren();
      expect(children.map(c => (c as InboxItem).title)).toEqual(['Alpha', 'Zebra']);
    });

    it('excludes accepted items', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Unseen' },
        { externalId: '2', title: 'Accepted' },
      ]);
      stateStore._set('gh', '2', 'accepted');
      const children = provider.getChildren();
      expect(children).toHaveLength(1);
      expect((children[0] as InboxItem).title).toBe('Unseen');
    });

    it('includes items from multiple providers', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'GH Issue' }]);
      registry._setItems('jira', [{ externalId: '2', title: 'JIRA Issue' }]);
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
    });

    it('returns empty array when no unseen items', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'Accepted' }]);
      stateStore._set('gh', '1', 'accepted');
      const children = provider.getChildren();
      expect(children).toHaveLength(0);
    });
  });
});
