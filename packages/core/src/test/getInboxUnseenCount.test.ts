import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'vscode';
import { WorkCenterProvider, DiscoveredItem } from '../api/types';
import { ProviderRegistry } from '../services/providerRegistry';
import { getInboxUnseenCount } from '../services/inboxBadge';

function createMockStateStore() {
  const cache = new Map<string, string>();
  return {
    getState: vi.fn((providerId: string, externalId: string) =>
      cache.get(`${providerId}::${externalId}`) as any,
    ),
    setState: vi.fn(async (providerId: string, externalId: string, state: string) => {
      cache.set(`${providerId}::${externalId}`, state);
    }),
    setStates: vi.fn(async (items: Array<{ providerId: string; externalId: string; state: string }>) => {
      for (const item of items) {
        cache.set(`${item.providerId}::${item.externalId}`, item.state);
      }
    }),
    load: vi.fn(async () => {}),
    loadAll: vi.fn(async () => []),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    _set: (providerId: string, externalId: string, state: string) => {
      cache.set(`${providerId}::${externalId}`, state);
    },
  };
}

function createMockProvider(id: string): WorkCenterProvider & { fireItems: (items: DiscoveredItem[]) => void } {
  const emitter = new EventEmitter<DiscoveredItem[]>();
  return {
    id,
    label: `Provider ${id}`,
    onDidDiscoverItems: emitter.event,
    refresh: vi.fn(async () => {}),
    fireItems: (items) => emitter.fire(items),
  };
}

describe('getInboxUnseenCount', () => {
  let stateStore: ReturnType<typeof createMockStateStore>;
  let registry: ProviderRegistry;

  beforeEach(() => {
    stateStore = createMockStateStore();
    registry = new ProviderRegistry(stateStore as any);
  });

  it('returns 0 when no providers registered', () => {
    expect(getInboxUnseenCount(registry, stateStore as any)).toBe(0);
  });

  it('counts items with no state as unseen', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    provider.fireItems([
      { externalId: '1', title: 'Issue 1' },
      { externalId: '2', title: 'Issue 2' },
    ]);

    expect(getInboxUnseenCount(registry, stateStore as any)).toBe(2);
  });

  it('counts items with explicit unseen state', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    provider.fireItems([
      { externalId: '1', title: 'Issue 1' },
    ]);
    stateStore._set('gh', '1', 'unseen');

    expect(getInboxUnseenCount(registry, stateStore as any)).toBe(1);
  });

  it('excludes accepted items', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    provider.fireItems([
      { externalId: '1', title: 'Issue 1' },
      { externalId: '2', title: 'Issue 2' },
    ]);
    stateStore._set('gh', '1', 'accepted');

    expect(getInboxUnseenCount(registry, stateStore as any)).toBe(1);
  });

  it('excludes dismissed items', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    provider.fireItems([
      { externalId: '1', title: 'Issue 1' },
      { externalId: '2', title: 'Issue 2' },
    ]);
    stateStore._set('gh', '1', 'dismissed');
    stateStore._set('gh', '2', 'dismissed');

    expect(getInboxUnseenCount(registry, stateStore as any)).toBe(0);
  });

  it('excludes read items', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    provider.fireItems([
      { externalId: '1', title: 'Issue 1' },
      { externalId: '2', title: 'Issue 2' },
    ]);
    stateStore._set('gh', '1', 'read');

    expect(getInboxUnseenCount(registry, stateStore as any)).toBe(1);
  });

  it('counts across multiple providers', () => {
    const p1 = createMockProvider('gh');
    const p2 = createMockProvider('jira');
    registry.register(p1);
    registry.register(p2);
    p1.fireItems([{ externalId: '1', title: 'GH Issue' }]);
    p2.fireItems([{ externalId: 'A', title: 'Jira Issue' }]);

    stateStore._set('gh', '1', 'accepted');

    expect(getInboxUnseenCount(registry, stateStore as any)).toBe(1);
  });
});
