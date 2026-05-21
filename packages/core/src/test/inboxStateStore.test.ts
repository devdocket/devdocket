import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockMemento } from 'vscode';
import { InboxStateStore } from '../storage/inboxStateStore';

describe('InboxStateStore', () => {
  let memento: InstanceType<typeof MockMemento>;
  let store: InboxStateStore;

  beforeEach(() => {
    memento = new MockMemento();
    store = new InboxStateStore(memento);
  });

  afterEach(() => {
    store.dispose();
  });

  // ── Basic get/set ──────────────────────────────────────────────────

  it('should return empty cache when no data exists on load', async () => {
    await store.load();
    const records = await store.loadAll();
    expect(records).toEqual([]);
  });

  it('should create a record and persist on setState', async () => {
    await store.setState('gh', 'issue-1', 'unseen');

    const persisted = memento.get<unknown[]>('devdocket.inbox-state');
    expect(persisted).toHaveLength(1);
    expect(persisted![0]).toEqual({
      providerId: 'gh',
      externalId: 'issue-1',
      inboxState: 'unseen',
    });
  });

  it('should return state for a known item from getState', async () => {
    await store.setState('gh', 'issue-1', 'accepted');
    expect(store.getState('gh', 'issue-1')).toBe('accepted');
  });

  it('should return undefined for an unknown item from getState', () => {
    expect(store.getState('gh', 'nonexistent')).toBeUndefined();
  });

  it('should update an existing record on setState', async () => {
    await store.setState('gh', 'issue-1', 'unseen');
    await store.setState('gh', 'issue-1', 'accepted');

    expect(store.getState('gh', 'issue-1')).toBe('accepted');

    const records = await store.loadAll();
    expect(records).toHaveLength(1);
    expect(records[0].inboxState).toBe('accepted');
  });

  it('should return all records from loadAll', async () => {
    await store.setState('gh', 'issue-1', 'unseen');
    await store.setState('gh', 'issue-2', 'accepted');
    await store.setState('jira', 'task-1', 'dismissed');

    const records = await store.loadAll();
    expect(records).toHaveLength(3);
    const ids = records.map((r) => r.externalId).sort();
    expect(ids).toEqual(['issue-1', 'issue-2', 'task-1']);
  });

  it('should treat same externalId from different providers as distinct', async () => {
    await store.setState('gh', 'id-1', 'unseen');
    await store.setState('jira', 'id-1', 'accepted');

    expect(store.getState('gh', 'id-1')).toBe('unseen');
    expect(store.getState('jira', 'id-1')).toBe('accepted');

    const records = await store.loadAll();
    expect(records).toHaveLength(2);
  });

  it('should fire onChange event when setState is called', async () => {
    const listener = vi.fn();
    store.onDidChange(listener);

    await store.setState('gh', 'issue-1', 'unseen');
    expect(listener).toHaveBeenCalledTimes(1);

    await store.setState('gh', 'issue-1', 'accepted');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('should load persisted state from a fresh store instance', async () => {
    await store.setState('gh', 'issue-1', 'accepted');
    await store.setState('gh', 'issue-2', 'dismissed');

    const store2 = new InboxStateStore(memento);
    await store2.load();

    expect(store2.getState('gh', 'issue-1')).toBe('accepted');
    expect(store2.getState('gh', 'issue-2')).toBe('dismissed');
    store2.dispose();
  });

  // ── Schema validation ─────────────────────────────────────────────

  describe('schema validation', () => {
    it('should skip records missing providerId', async () => {
      await memento.update('devdocket.inbox-state', [
        { externalId: 'issue-1', inboxState: 'unseen' },
        { providerId: 'gh', externalId: 'issue-2', inboxState: 'accepted' },
      ]);

      const store2 = new InboxStateStore(memento);
      const records = await store2.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('issue-2');
      store2.dispose();
    });

    it('should skip records missing externalId', async () => {
      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', inboxState: 'unseen' },
        { providerId: 'gh', externalId: 'issue-2', inboxState: 'accepted' },
      ]);

      const store2 = new InboxStateStore(memento);
      const records = await store2.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('issue-2');
      store2.dispose();
    });

    it('should skip records with invalid inboxState', async () => {
      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', externalId: 'issue-1', inboxState: 'bogus' },
        { providerId: 'gh', externalId: 'issue-2', inboxState: 'accepted' },
      ]);

      const store2 = new InboxStateStore(memento);
      const records = await store2.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('issue-2');
      store2.dispose();
    });

    it('should return empty for non-array data', async () => {
      await memento.update('devdocket.inbox-state', { not: 'an array' });

      const store2 = new InboxStateStore(memento);
      const records = await store2.loadAll();
      expect(records).toEqual([]);
      store2.dispose();
    });

    it('should skip non-object entries', async () => {
      await memento.update('devdocket.inbox-state', [
        'a string',
        42,
        null,
        { providerId: 'gh', externalId: 'issue-1', inboxState: 'accepted' },
      ]);

      const store2 = new InboxStateStore(memento);
      const records = await store2.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('issue-1');
      store2.dispose();
    });
  });

  // ── setStates (batch) ─────────────────────────────────────────────

  describe('setStates', () => {
    it('should set multiple items in a single call', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'issue-1', state: 'unseen' },
        { providerId: 'gh', externalId: 'issue-2', state: 'accepted' },
        { providerId: 'jira', externalId: 'task-1', state: 'dismissed' },
      ]);

      expect(store.getState('gh', 'issue-1')).toBe('unseen');
      expect(store.getState('gh', 'issue-2')).toBe('accepted');
      expect(store.getState('jira', 'task-1')).toBe('dismissed');

      const records = await store.loadAll();
      expect(records).toHaveLength(3);
    });

    it('should persist all items to globalState', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'a', state: 'unseen' },
        { providerId: 'gh', externalId: 'b', state: 'accepted' },
      ]);

      const persisted = memento.get<unknown[]>('devdocket.inbox-state');
      expect(persisted).toHaveLength(2);
    });

    it('should update existing items', async () => {
      await store.setState('gh', 'issue-1', 'unseen');

      await store.setStates([
        { providerId: 'gh', externalId: 'issue-1', state: 'accepted' },
      ]);

      expect(store.getState('gh', 'issue-1')).toBe('accepted');
      const records = await store.loadAll();
      expect(records).toHaveLength(1);
    });

    it('should handle mix of new and existing items', async () => {
      await store.setState('gh', 'existing', 'unseen');

      await store.setStates([
        { providerId: 'gh', externalId: 'existing', state: 'dismissed' },
        { providerId: 'gh', externalId: 'new-item', state: 'accepted' },
      ]);

      expect(store.getState('gh', 'existing')).toBe('dismissed');
      expect(store.getState('gh', 'new-item')).toBe('accepted');
      const records = await store.loadAll();
      expect(records).toHaveLength(2);
    });

    it('should fire onDidChange exactly once per call', async () => {
      const listener = vi.fn();
      store.onDidChange(listener);

      await store.setStates([
        { providerId: 'gh', externalId: 'a', state: 'unseen' },
        { providerId: 'gh', externalId: 'b', state: 'accepted' },
      ]);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should handle an empty array gracefully', async () => {
      await store.setState('gh', 'issue-1', 'unseen');

      await store.setStates([]);

      expect(store.getState('gh', 'issue-1')).toBe('unseen');
      const records = await store.loadAll();
      expect(records).toHaveLength(1);
    });

    it('should handle duplicate keys in the same batch (last wins)', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'dup', state: 'unseen' },
        { providerId: 'gh', externalId: 'dup', state: 'accepted' },
      ]);

      expect(store.getState('gh', 'dup')).toBe('accepted');
      const records = await store.loadAll();
      expect(records).toHaveLength(1);
    });
  });

  // ── Cache invalidation ────────────────────────────────────────────

  describe('cache invalidation', () => {
    it('setState overwrites previous cache entry', async () => {
      await store.setState('gh', 'issue-1', 'unseen');
      await store.setState('gh', 'issue-1', 'dismissed');

      expect(store.getState('gh', 'issue-1')).toBe('dismissed');
      const records = await store.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].inboxState).toBe('dismissed');
    });

    it('setStates overwrites previous cache entries', async () => {
      await store.setState('gh', 'issue-1', 'unseen');
      await store.setState('gh', 'issue-2', 'unseen');

      await store.setStates([
        { providerId: 'gh', externalId: 'issue-1', state: 'accepted' },
        { providerId: 'gh', externalId: 'issue-2', state: 'dismissed' },
      ]);

      expect(store.getState('gh', 'issue-1')).toBe('accepted');
      expect(store.getState('gh', 'issue-2')).toBe('dismissed');
    });

    it('invalidateCache forces a re-read on next load', async () => {
      await store.setState('gh', 'issue-1', 'unseen');

      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', externalId: 'issue-1', inboxState: 'dismissed' },
      ]);

      store.invalidateCache();
      await store.load();

      expect(store.getState('gh', 'issue-1')).toBe('dismissed');
    });
  });

  describe('merge-on-write', () => {
    it('preserves remote additions while persisting local changes', async () => {
      const windowA = new InboxStateStore(memento);
      const windowB = new InboxStateStore(memento);
      await windowA.load();

      await windowB.setState('gh', 'remote', 'accepted');
      await windowA.setState('gh', 'local', 'unseen');

      const records = (await windowA.loadAll())
        .map(record => `${record.providerId}::${record.externalId}:${record.inboxState}`)
        .sort();
      expect(records).toEqual([
        'gh::local:unseen',
        'gh::remote:accepted',
      ]);

      windowA.dispose();
      windowB.dispose();
    });

    it('keeps remote updates for untouched keys', async () => {
      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', externalId: 'shared', inboxState: 'unseen' },
      ]);

      const windowA = new InboxStateStore(memento);
      const windowB = new InboxStateStore(memento);
      await windowA.load();
      await windowB.load();

      await windowB.setState('gh', 'shared', 'dismissed');
      await windowA.setState('gh', 'local', 'accepted');

      expect(windowA.getState('gh', 'shared')).toBe('dismissed');
      expect(windowA.getState('gh', 'local')).toBe('accepted');

      windowA.dispose();
      windowB.dispose();
    });

    it('prefers local updates for keys changed in this window', async () => {
      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', externalId: 'shared', inboxState: 'unseen' },
      ]);

      const windowA = new InboxStateStore(memento);
      const windowB = new InboxStateStore(memento);
      await windowA.load();
      await windowB.load();

      await windowB.setState('gh', 'shared', 'dismissed');
      await windowA.setState('gh', 'shared', 'accepted');

      expect(windowA.getState('gh', 'shared')).toBe('accepted');
      expect(memento.get<Array<{ inboxState: string }>>('devdocket.inbox-state')?.[0]?.inboxState).toBe('accepted');

      windowA.dispose();
      windowB.dispose();
    });

    it('retains dirty tracking when persist fails', async () => {
      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', externalId: 'shared', inboxState: 'unseen' },
      ]);

      const failingMemento = {
        get: (key: string) => memento.get(key),
        update: vi.fn()
          .mockRejectedValueOnce(new Error('quota exceeded'))
          .mockImplementation((key: string, value: unknown) => memento.update(key, value)),
      };
      const failingStore = new InboxStateStore(failingMemento as any);
      await failingStore.load();

      await expect(failingStore.setState('gh', 'shared', 'accepted')).rejects.toThrow('quota exceeded');

      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', externalId: 'shared', inboxState: 'dismissed' },
      ]);

      await failingStore.setState('gh', 'other', 'unseen');

      const records = await failingStore.loadAll();
      expect(records.map(record => `${record.externalId}:${record.inboxState}`).sort()).toEqual([
        'other:unseen',
        'shared:accepted',
      ]);

      failingStore.dispose();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('load is idempotent after first call', async () => {
      await store.setState('gh', 'issue-1', 'unseen');

      await store.load();
      expect(store.getState('gh', 'issue-1')).toBe('unseen');
    });

    it('setState triggers lazy load if not yet loaded', async () => {
      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', externalId: 'pre-existing', inboxState: 'unseen' },
      ]);

      const freshStore = new InboxStateStore(memento);
      await freshStore.setState('gh', 'new-item', 'accepted');

      expect(freshStore.getState('gh', 'pre-existing')).toBe('unseen');
      expect(freshStore.getState('gh', 'new-item')).toBe('accepted');
      freshStore.dispose();
    });

    it('setStates triggers lazy load if not yet loaded', async () => {
      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', externalId: 'pre-existing', inboxState: 'dismissed' },
      ]);

      const freshStore = new InboxStateStore(memento);
      await freshStore.setStates([
        { providerId: 'gh', externalId: 'new-item', state: 'unseen' },
      ]);

      expect(freshStore.getState('gh', 'pre-existing')).toBe('dismissed');
      expect(freshStore.getState('gh', 'new-item')).toBe('unseen');
      freshStore.dispose();
    });

    it('handles special characters in providerId and externalId', async () => {
      const providerId = 'provider/with spaces-and-unicode-\u00df';
      const externalId = 'id/with/slashes?and=query#fragment';
      await store.setState(providerId, externalId, 'accepted');
      expect(store.getState(providerId, externalId)).toBe('accepted');
    });

    it('delimiter in ids causes key collision (documents limitation)', async () => {
      await store.setState('a::b', 'c', 'unseen');
      await store.setState('a', 'b::c', 'accepted');

      const records = await store.loadAll();
      expect(records).toHaveLength(1);
      expect(store.getState('a', 'b::c')).toBe('accepted');
      expect(store.getState('a::b', 'c')).toBe('accepted');
    });

    it('handles empty string providerId and externalId', async () => {
      await store.setState('', '', 'unseen');
      expect(store.getState('', '')).toBe('unseen');
      const records = await store.loadAll();
      expect(records).toHaveLength(1);
    });

    it('loadAll returns array independent of future setState calls', async () => {
      await store.setState('gh', 'issue-1', 'unseen');

      const records1 = await store.loadAll();
      await store.setState('gh', 'issue-1', 'accepted');
      const records2 = await store.loadAll();

      expect(records1).toEqual([
        { providerId: 'gh', externalId: 'issue-1', inboxState: 'unseen' },
      ]);
      expect(records2).toEqual([
        { providerId: 'gh', externalId: 'issue-1', inboxState: 'accepted' },
      ]);
    });

    it('dispose cleans up event emitter', async () => {
      const listener = vi.fn();
      store.onDidChange(listener);

      expect(() => store.dispose()).not.toThrow();

      await store.setState('gh', 'issue-after-dispose', 'accepted');
      expect(listener).not.toHaveBeenCalled();
    });

    it('should handle large sets (1000+ items)', async () => {
      const items = Array.from({ length: 1200 }, (_, i) => ({
        providerId: 'gh',
        externalId: `item-${i}`,
        state: 'unseen' as const,
      }));
      await store.setStates(items);

      const records = await store.loadAll();
      expect(records).toHaveLength(1200);

      expect(store.getState('gh', 'item-0')).toBe('unseen');
      expect(store.getState('gh', 'item-599')).toBe('unseen');
      expect(store.getState('gh', 'item-1199')).toBe('unseen');

      // Verify persistence by reloading from a fresh instance
      const store2 = new InboxStateStore(memento);
      await store2.load();
      const reloaded = await store2.loadAll();
      expect(reloaded).toHaveLength(1200);
      store2.dispose();
    });

    it('should fire onDidChange for each setState call', async () => {
      const listener = vi.fn();
      store.onDidChange(listener);

      await store.setState('gh', 'x', 'unseen');
      await store.setState('gh', 'y', 'accepted');
      await store.setState('gh', 'z', 'dismissed');

      expect(listener).toHaveBeenCalledTimes(3);
    });
  });

  // ── Version tracking ─────────────────────────────────────────────

  describe('version tracking', () => {
    it('should store and retrieve version via setState', async () => {
      await store.setState('gh', 'pr-1', 'unseen', 'sha-abc');
      expect(store.getVersion('gh', 'pr-1')).toBe('sha-abc');
    });

    it('should return undefined version for item without version', async () => {
      await store.setState('gh', 'pr-1', 'unseen');
      expect(store.getVersion('gh', 'pr-1')).toBeUndefined();
    });

    it('should preserve existing version when setState called without version', async () => {
      await store.setState('gh', 'pr-1', 'unseen', 'sha-abc');
      await store.setState('gh', 'pr-1', 'accepted');
      expect(store.getVersion('gh', 'pr-1')).toBe('sha-abc');
    });

    it('should overwrite version when setState called with new version', async () => {
      await store.setState('gh', 'pr-1', 'unseen', 'sha-old');
      await store.setState('gh', 'pr-1', 'unseen', 'sha-new');
      expect(store.getVersion('gh', 'pr-1')).toBe('sha-new');
    });

    it('should persist version to globalState', async () => {
      await store.setState('gh', 'pr-1', 'unseen', 'sha-abc');

      const persisted = memento.get<unknown[]>('devdocket.inbox-state');
      expect((persisted![0] as any).version).toBe('sha-abc');
    });

    it('should load version from globalState', async () => {
      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', externalId: 'pr-1', inboxState: 'accepted', version: 'sha-disk' },
      ]);

      const freshStore = new InboxStateStore(memento);
      await freshStore.load();
      expect(freshStore.getVersion('gh', 'pr-1')).toBe('sha-disk');
      freshStore.dispose();
    });

    it('should preserve version in setStates when not provided', async () => {
      await store.setState('gh', 'pr-1', 'unseen', 'sha-abc');
      await store.setStates([
        { providerId: 'gh', externalId: 'pr-1', state: 'accepted' },
      ]);
      expect(store.getVersion('gh', 'pr-1')).toBe('sha-abc');
    });

    it('should update version in setStates when provided', async () => {
      await store.setState('gh', 'pr-1', 'unseen', 'sha-old');
      await store.setStates([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', version: 'sha-new' },
      ]);
      expect(store.getVersion('gh', 'pr-1')).toBe('sha-new');
    });

    it('should skip records with non-string version during load', async () => {
      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', externalId: 'pr-1', inboxState: 'accepted', version: 42 },
        { providerId: 'gh', externalId: 'pr-2', inboxState: 'accepted', version: 'valid' },
      ]);

      const freshStore = new InboxStateStore(memento);
      const records = await freshStore.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('pr-2');
      freshStore.dispose();
    });
  });

  // ── ResurfaceVersion tracking ─────────────────────────────────────

  describe('resurfaceVersion tracking', () => {
    it('should store and retrieve resurfaceVersion via setStates', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', resurfaceVersion: 'rv-abc' },
      ]);
      expect(store.getResurfaceVersion('gh', 'pr-1')).toBe('rv-abc');
    });

    it('should return undefined resurfaceVersion for item without it', async () => {
      await store.setState('gh', 'pr-1', 'unseen');
      expect(store.getResurfaceVersion('gh', 'pr-1')).toBeUndefined();
    });

    it('should preserve existing resurfaceVersion when setState called without it', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', resurfaceVersion: 'rv-abc' },
      ]);
      await store.setState('gh', 'pr-1', 'accepted');
      expect(store.getResurfaceVersion('gh', 'pr-1')).toBe('rv-abc');
    });

    it('should preserve resurfaceVersion in setStates when not provided', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', resurfaceVersion: 'rv-abc' },
      ]);
      await store.setStates([
        { providerId: 'gh', externalId: 'pr-1', state: 'accepted' },
      ]);
      expect(store.getResurfaceVersion('gh', 'pr-1')).toBe('rv-abc');
    });

    it('should update resurfaceVersion in setStates when provided', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', resurfaceVersion: 'rv-old' },
      ]);
      await store.setStates([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', resurfaceVersion: 'rv-new' },
      ]);
      expect(store.getResurfaceVersion('gh', 'pr-1')).toBe('rv-new');
    });

    it('should persist resurfaceVersion to globalState', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'pr-1', state: 'unseen', resurfaceVersion: 'rv-abc' },
      ]);

      const persisted = memento.get<unknown[]>('devdocket.inbox-state');
      expect((persisted![0] as any).resurfaceVersion).toBe('rv-abc');
    });

    it('should load resurfaceVersion from globalState', async () => {
      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', externalId: 'pr-1', inboxState: 'accepted', resurfaceVersion: 'rv-disk' },
      ]);

      const freshStore = new InboxStateStore(memento);
      await freshStore.load();
      expect(freshStore.getResurfaceVersion('gh', 'pr-1')).toBe('rv-disk');
      freshStore.dispose();
    });

    it('should skip records with non-string resurfaceVersion during load', async () => {
      await memento.update('devdocket.inbox-state', [
        { providerId: 'gh', externalId: 'pr-1', inboxState: 'accepted', resurfaceVersion: 99 },
        { providerId: 'gh', externalId: 'pr-2', inboxState: 'accepted', resurfaceVersion: 'valid' },
      ]);

      const freshStore = new InboxStateStore(memento);
      const records = await freshStore.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('pr-2');
      freshStore.dispose();
    });
  });

  // ── prune ──────────────────────────────────────────────────────────

  describe('prune', () => {
    it('should remove stale records for providers that have active items', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'issue-1', state: 'accepted' },
        { providerId: 'gh', externalId: 'issue-2', state: 'accepted' },
        { providerId: 'gh', externalId: 'issue-3', state: 'dismissed' },
      ]);

      const activeItems = new Map([
        ['gh', [
          { externalId: 'issue-1', title: 'Issue 1' },
          { externalId: 'issue-2', title: 'Issue 2' },
        ]],
      ]);

      const pruned = await store.prune(activeItems);

      expect(pruned).toBe(1);
      expect(store.getState('gh', 'issue-1')).toBe('accepted');
      expect(store.getState('gh', 'issue-2')).toBe('accepted');
      expect(store.getState('gh', 'issue-3')).toBeUndefined();
    });

    it('should skip providers with empty item arrays', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'issue-1', state: 'accepted' },
      ]);

      const activeItems = new Map([
        ['gh', []],
      ]);

      const pruned = await store.prune(activeItems);

      expect(pruned).toBe(0);
      expect(store.getState('gh', 'issue-1')).toBe('accepted');
    });

    it('should not prune when no active providers have items', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'issue-1', state: 'unseen' },
        { providerId: 'jira', externalId: 'task-1', state: 'accepted' },
      ]);

      const activeItems = new Map([
        ['gh', []],
        ['jira', []],
      ]);

      const pruned = await store.prune(activeItems);

      expect(pruned).toBe(0);
      expect(store.getState('gh', 'issue-1')).toBe('unseen');
      expect(store.getState('jira', 'task-1')).toBe('accepted');
    });

    it('should only prune keys belonging to active providers', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'issue-1', state: 'accepted' },
        { providerId: 'gh', externalId: 'issue-2', state: 'accepted' },
        { providerId: 'jira', externalId: 'task-1', state: 'dismissed' },
      ]);

      // Only 'gh' is in the active map; 'jira' is absent entirely.
      const activeItems = new Map([
        ['gh', [
          { externalId: 'issue-1', title: 'Issue 1' },
        ]],
      ]);

      const pruned = await store.prune(activeItems);

      expect(pruned).toBe(1);
      expect(store.getState('gh', 'issue-1')).toBe('accepted');
      expect(store.getState('gh', 'issue-2')).toBeUndefined();
      // jira records preserved — provider not in active map
      expect(store.getState('jira', 'task-1')).toBe('dismissed');
    });

    it('should fire onDidChange when records are pruned', async () => {
      await store.setState('gh', 'issue-1', 'accepted');
      await store.setState('gh', 'issue-2', 'accepted');

      const listener = vi.fn();
      store.onDidChange(listener);

      const activeItems = new Map([
        ['gh', [{ externalId: 'issue-1', title: 'Issue 1' }]],
      ]);

      await store.prune(activeItems);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should not fire onDidChange when nothing is pruned', async () => {
      await store.setState('gh', 'issue-1', 'accepted');

      const listener = vi.fn();
      store.onDidChange(listener);

      const activeItems = new Map([
        ['gh', [{ externalId: 'issue-1', title: 'Issue 1' }]],
      ]);

      await store.prune(activeItems);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should return the count of pruned records', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'issue-1', state: 'accepted' },
        { providerId: 'gh', externalId: 'issue-2', state: 'dismissed' },
        { providerId: 'gh', externalId: 'issue-3', state: 'unseen' },
      ]);

      const activeItems = new Map([
        ['gh', [{ externalId: 'issue-1', title: 'Issue 1' }]],
      ]);

      const pruned = await store.prune(activeItems);
      expect(pruned).toBe(2);
    });
  });
});
