import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'vscode';
import { DiscoveredItem } from '../api/types';
import { SourcesTreeProvider, SourceItemNode } from '../views/sourcesTreeProvider';

function createMockStateStore() {
  const cache = new Map<string, string>();
  const emitter = new EventEmitter<void>();
  return {
    getState: vi.fn((pid: string, eid: string) => cache.get(`${pid}::${eid}`) as any),
    onDidChange: emitter.event,
    _set: (pid: string, eid: string, state: string) => cache.set(`${pid}::${eid}`, state),
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
    _setItems: (pid: string, list: DiscoveredItem[]) => { items.set(pid, list); },
    _setLabel: (pid: string, label: string) => { labels.set(pid, label); },
    _fire: () => emitter.fire(),
  };
}

describe('SourcesTreeProvider layout toggle', () => {
  let stateStore: ReturnType<typeof createMockStateStore>;
  let registry: ReturnType<typeof createMockProviderRegistry>;
  let provider: SourcesTreeProvider;

  beforeEach(() => {
    stateStore = createMockStateStore();
    registry = createMockProviderRegistry();
    provider = new SourcesTreeProvider(registry as any, stateStore as any);
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

    it('returns all items directly without hierarchy', () => {
      registry._setItems('gh', [
        { externalId: '1', title: 'Issue #1', group: 'repo-a' },
        { externalId: '2', title: 'PR #1', group: 'repo-b' },
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
      expect(children.map(c => (c as SourceItemNode).title)).toEqual(['Alpha', 'Zebra']);
    });

    it('includes items from multiple providers', () => {
      registry._setItems('gh', [{ externalId: '1', title: 'GH Issue' }]);
      registry._setItems('jira', [{ externalId: '2', title: 'JIRA Issue' }]);
      const children = provider.getChildren();
      expect(children).toHaveLength(2);
    });

    it('returns empty array when no items exist', () => {
      const children = provider.getChildren();
      expect(children).toEqual([]);
    });

    it('skips providers with no items', () => {
      registry._setItems('gh', []);
      registry._setItems('jira', [{ externalId: '1', title: 'A' }]);
      const children = provider.getChildren();
      expect(children).toHaveLength(1);
    });
  });
});
