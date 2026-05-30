import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'vscode';
import { DevDocketProvider, ProviderItem } from '../api/types';
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

function createMockProvider(id: string): DevDocketProvider & { fireItems: (items: ProviderItem[]) => void } {
  const emitter = new EventEmitter<ProviderItem[]>();
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

  it('excludes items present in seenItems set', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    provider.fireItems([
      { externalId: '1', title: 'Issue 1' },
      { externalId: '2', title: 'Issue 2' },
    ]);

    const seen = new Set(['gh::1']);
    expect(getInboxUnseenCount(registry, stateStore as any, seen)).toBe(1);
  });

  it('still counts unseen items not in seenItems set', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    provider.fireItems([
      { externalId: '1', title: 'Issue 1' },
      { externalId: '2', title: 'Issue 2' },
      { externalId: '3', title: 'Issue 3' },
    ]);

    const seen = new Set(['gh::2']);
    expect(getInboxUnseenCount(registry, stateStore as any, seen)).toBe(2);
  });

  it('returns full count when seenItems is undefined', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    provider.fireItems([
      { externalId: '1', title: 'Issue 1' },
      { externalId: '2', title: 'Issue 2' },
    ]);

    expect(getInboxUnseenCount(registry, stateStore as any, undefined)).toBe(2);
  });

  it('returns full count when seenItems is empty', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    provider.fireItems([
      { externalId: '1', title: 'Issue 1' },
      { externalId: '2', title: 'Issue 2' },
    ]);

    expect(getInboxUnseenCount(registry, stateStore as any, new Set())).toBe(2);
  });

  it('does not double-exclude items that are both seen and accepted', () => {
    const provider = createMockProvider('gh');
    registry.register(provider);
    provider.fireItems([
      { externalId: '1', title: 'Issue 1' },
      { externalId: '2', title: 'Issue 2' },
    ]);
    stateStore._set('gh', '1', 'accepted');

    const seen = new Set(['gh::1', 'gh::2']);
    expect(getInboxUnseenCount(registry, stateStore as any, seen)).toBe(0);
  });

  it('deduplicates items sharing the same canonicalId across providers', () => {
    const p1 = createMockProvider('prs');
    const p2 = createMockProvider('reviews');
    registry.register(p1);
    registry.register(p2);
    p1.fireItems([{ externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' }]);
    p2.fireItems([{ externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' }]);

    // Should count as 1, not 2
    expect(getInboxUnseenCount(registry, stateStore as any)).toBe(1);
  });

  it('does not dedup items without canonicalId', () => {
    const p1 = createMockProvider('prs');
    const p2 = createMockProvider('reviews');
    registry.register(p1);
    registry.register(p2);
    p1.fireItems([{ externalId: 'repo#1', title: 'PR #1' }]);
    p2.fireItems([{ externalId: 'repo#1', title: 'PR #1' }]);

    expect(getInboxUnseenCount(registry, stateStore as any)).toBe(2);
  });

  it('dedup does not affect items with different canonicalIds', () => {
    const p1 = createMockProvider('prs');
    registry.register(p1);
    p1.fireItems([
      { externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' },
      { externalId: 'repo#2', title: 'PR #2', canonicalId: 'github:pull:repo#2' },
    ]);

    expect(getInboxUnseenCount(registry, stateStore as any)).toBe(2);
  });

  it('treats canonical group as seen when any peer is in seenItems', () => {
    const p1 = createMockProvider('prs');
    const p2 = createMockProvider('reviews');
    registry.register(p1);
    registry.register(p2);
    p1.fireItems([{ externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' }]);
    p2.fireItems([{ externalId: 'repo#1', title: 'PR #1', canonicalId: 'github:pull:repo#1' }]);

    // Mark one peer as seen — the representative (prs::repo#1) should also count as seen
    const seen = new Set(['reviews::repo#1']);
    // Canonical dedup hides the non-representative peer; the representative (prs::repo#1)
    // is treated as seen because its canonical peer is in seenItems
    expect(getInboxUnseenCount(registry, stateStore as any, seen)).toBe(0);
  });

  // Regression for issue #736: badge stuck off-by-one.
  // The badge must compute from the JOIN of (inbox-state unseen) ∩ (live provider
  // items), NOT from inbox-state rows alone. Otherwise an orphan unseen row whose
  // provider no longer emits the matching externalId (closed/deleted upstream item,
  // provider extension uninstalled, etc.) inflates the badge forever and the badge
  // never reaches 0.
  describe('orphan inbox-state rows (regression for #736)', () => {
    it('does not count an unseen row when the provider no longer emits a matching item', () => {
      const provider = createMockProvider('gh');
      registry.register(provider);
      // Provider emits no items at all.
      provider.fireItems([]);
      // But inbox-state still has an orphan 'unseen' row pointing at a
      // (providerId, externalId) the provider no longer surfaces.
      stateStore._set('gh', 'ghost-issue', 'unseen');

      expect(getInboxUnseenCount(registry, stateStore as any)).toBe(0);
    });

    it('does not count an unseen row for a providerId that has no registered provider', () => {
      // No providers at all — inbox-state has a row left over from a provider
      // extension that was uninstalled.
      stateStore._set('uninstalled-provider', 'item-1', 'unseen');

      expect(getInboxUnseenCount(registry, stateStore as any)).toBe(0);
    });

    it('counts only the live unseen item when one live + one orphan unseen coexist', () => {
      const provider = createMockProvider('gh');
      registry.register(provider);
      provider.fireItems([{ externalId: 'live-1', title: 'Live issue' }]);
      // Orphan: not in the provider's items array but still in inbox-state.
      stateStore._set('gh', 'orphan-1', 'unseen');

      expect(getInboxUnseenCount(registry, stateStore as any)).toBe(1);
    });

    it('reaches 0 after the last live unread item is marked seen, even with orphan rows present', () => {
      // Reproduces the user-reported sequence from #736:
      //   1. Two items arrive in Incoming → badge counts both.
      //   2. Mark first item read → badge drops by 1.
      //   3. Mark second item read → badge MUST drop to 0 (was stuck at 1).
      // Add an orphan unseen row in inbox-state to prove it can't inflate
      // the badge at any point in the sequence.
      const provider = createMockProvider('gh');
      registry.register(provider);
      provider.fireItems([
        { externalId: 'item-1', title: 'Issue 1' },
        { externalId: 'item-2', title: 'Issue 2' },
      ]);
      stateStore._set('gh', 'orphan-from-deleted-item', 'unseen');

      // Step 1: both items unread, orphan must not contribute.
      expect(getInboxUnseenCount(registry, stateStore as any, new Set())).toBe(2);

      // Step 2: user clicks item 1 → markSeen adds to read-state.
      const afterFirstRead = new Set(['gh::item-1']);
      expect(getInboxUnseenCount(registry, stateStore as any, afterFirstRead)).toBe(1);

      // Step 3: user clicks item 2 → badge must reach 0, not stay at 1.
      const afterSecondRead = new Set(['gh::item-1', 'gh::item-2']);
      expect(getInboxUnseenCount(registry, stateStore as any, afterSecondRead)).toBe(0);
    });

    it('reaches 0 with an empty Incoming tier even when inbox-state has unseen rows for missing items', () => {
      // Mirrors the user's headline symptom: "badge shows 1 with empty Incoming tier".
      // No live items exist for the unseen row → badge must be 0.
      const provider = createMockProvider('gh');
      registry.register(provider);
      provider.fireItems([]);
      stateStore._set('gh', 'closed-upstream', 'unseen');

      expect(getInboxUnseenCount(registry, stateStore as any, new Set())).toBe(0);
    });

    // Inverse direction: when a synthetic provider item is registered (e.g. via
    // the Create Item from URL command), but no inbox-state row is written, the
    // item has *no* state — which `getInboxUnseenCount` treats as 'unseen'. This
    // is the root cause of #736: handleCreateItemFromUrl was registering the
    // synthetic item without calling stateStore.setState('accepted'). The fix
    // adds that call; this test documents that the registry → counter pipeline
    // does require the state row, so the fix must be applied at every site that
    // calls registerSyntheticProviderItem.
    it('counts a registered synthetic provider item with no inbox-state row as unseen', () => {
      const provider = createMockProvider('gh');
      registry.register(provider);
      // No discovered items yet.
      provider.fireItems([]);
      // Simulate the Create Item from URL flow: a synthetic provider item is
      // injected but no inbox-state row is set.
      registry.registerSyntheticProviderItem('gh', {
        externalId: 'pasted-url-1',
        title: 'Pasted from URL',
        itemType: 'pr',
      });

      // Without setState('accepted'), this synthetic item produces a phantom
      // unread that the user cannot dismiss. The fix in handleCreateItemFromUrl
      // ensures setState IS called, dropping this to 0 in the real lifecycle.
      expect(getInboxUnseenCount(registry, stateStore as any, new Set())).toBe(1);

      // With the inbox-state row set to 'accepted' (which the fix now does),
      // the badge correctly reaches 0.
      stateStore._set('gh', 'pasted-url-1', 'accepted');
      expect(getInboxUnseenCount(registry, stateStore as any, new Set())).toBe(0);
    });
  });
});
