import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';

const mockLimits = vi.hoisted(() => ({ MAX_STORE_FILE_SIZE: 10 * 1024 * 1024 }));
vi.mock('../storage/limits', () => mockLimits);

describe('DiscoveredStateStore', () => {
  let tmpDir: string;
  let store: DiscoveredStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devdocket-state-test-'));
    store = new DiscoveredStateStore(tmpDir);
  });

  afterEach(async () => {
    store.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Basic get/set ──────────────────────────────────────────────────

  it('should return empty cache when file is missing on load', async () => {
    await store.load();
    const records = await store.loadAll();
    expect(records).toEqual([]);
  });

  it('should create a record and persist on setState', async () => {
    await store.setState('gh', 'issue-1', 'unseen');

    const filePath = path.join(tmpDir, 'discovered-state.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
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

  it('should load persisted state from disk', async () => {
    await store.setState('gh', 'issue-1', 'accepted');
    await store.setState('gh', 'issue-2', 'dismissed');

    // Create a fresh store pointing at same directory
    const store2 = new DiscoveredStateStore(tmpDir);
    await store2.load();

    expect(store2.getState('gh', 'issue-1')).toBe('accepted');
    expect(store2.getState('gh', 'issue-2')).toBe('dismissed');
    store2.dispose();
  });

  it('should handle corrupted JSON gracefully by loading empty and backing up', async () => {
    const filePath = path.join(tmpDir, 'discovered-state.json');
    await fs.writeFile(filePath, 'not valid json', 'utf-8');

    await store.load();
    const records = await store.loadAll();
    expect(records).toEqual([]);

    // Verify the corrupted file was backed up
    const files = await fs.readdir(tmpDir);
    const backupFiles = files.filter(f => f.startsWith('discovered-state.json.corrupt.'));
    expect(backupFiles).toHaveLength(1);
  });

  it('should serialize concurrent setState calls without lost writes', async () => {
    const count = 20;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(store.setState('gh', `issue-${i}`, 'unseen'));
    }
    await Promise.all(promises);

    const records = await store.loadAll();
    expect(records).toHaveLength(count);

    const filePath = path.join(tmpDir, 'discovered-state.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const persisted = JSON.parse(raw);
    expect(persisted).toHaveLength(count);
  });

  it('should serialize concurrent setStates calls without corruption', async () => {
    const batch1 = [
      { providerId: 'gh', externalId: 'a1', state: 'unseen' as const },
      { providerId: 'gh', externalId: 'a2', state: 'accepted' as const },
    ];
    const batch2 = [
      { providerId: 'jira', externalId: 'b1', state: 'dismissed' as const },
      { providerId: 'jira', externalId: 'b2', state: 'unseen' as const },
    ];
    const batch3 = [
      { providerId: 'gh', externalId: 'a1', state: 'dismissed' as const },
    ];

    await Promise.all([
      store.setStates(batch1),
      store.setStates(batch2),
      store.setStates(batch3),
    ]);

    const records = await store.loadAll();
    // a1, a2, b1, b2 — four distinct keys
    expect(records).toHaveLength(4);

    const filePath = path.join(tmpDir, 'discovered-state.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const persisted = JSON.parse(raw);
    expect(persisted).toHaveLength(4);

    // a1 was set by both batch1 and batch3; the final value depends on
    // serialization order but must be one of the two, not corrupted
    const a1 = persisted.find((r: any) => r.externalId === 'a1');
    expect(['unseen', 'dismissed']).toContain(a1.inboxState);
  });

  it('should create storage directory if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'path');
    const nestedStore = new DiscoveredStateStore(nestedDir);

    await nestedStore.setState('gh', 'issue-1', 'unseen');

    const filePath = path.join(nestedDir, 'discovered-state.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toHaveLength(1);
    nestedStore.dispose();
  });

  describe('schema validation', () => {
    it('should skip records missing providerId', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      const data = [
        { externalId: 'issue-1', inboxState: 'unseen' },
        { providerId: 'gh', externalId: 'issue-2', inboxState: 'accepted' },
      ];
      await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');

      const records = await store.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('issue-2');
    });

    it('should skip records missing externalId', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      const data = [
        { providerId: 'gh', inboxState: 'unseen' },
        { providerId: 'gh', externalId: 'issue-2', inboxState: 'accepted' },
      ];
      await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');

      const records = await store.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('issue-2');
    });

    it('should skip records with invalid inboxState', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      const data = [
        { providerId: 'gh', externalId: 'issue-1', inboxState: 'bogus' },
        { providerId: 'gh', externalId: 'issue-2', inboxState: 'accepted' },
      ];
      await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');

      const records = await store.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('issue-2');
    });

    it('should return empty for non-array JSON and back up', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, JSON.stringify({ not: 'an array' }), 'utf-8');

      const records = await store.loadAll();
      expect(records).toEqual([]);

      const files = await fs.readdir(tmpDir);
      const backupFiles = files.filter(f => f.startsWith('discovered-state.json.corrupt.'));
      expect(backupFiles).toHaveLength(1);
    });

    it('should skip non-object entries', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      const data = [
        'a string',
        42,
        null,
        { providerId: 'gh', externalId: 'issue-1', inboxState: 'accepted' },
      ];
      await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');

      const records = await store.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('issue-1');
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

    it('should persist all items to disk', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'a', state: 'unseen' },
        { providerId: 'gh', externalId: 'b', state: 'accepted' },
      ]);

      const filePath = path.join(tmpDir, 'discovered-state.json');
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(2);
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

      // Existing data should be untouched
      expect(store.getState('gh', 'issue-1')).toBe('unseen');
      const records = await store.loadAll();
      expect(records).toHaveLength(1);
    });

    it('should handle duplicate keys in the same batch (last wins)', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'dup', state: 'unseen' },
        { providerId: 'gh', externalId: 'dup', state: 'accepted' },
      ]);

      // The implementation iterates in order, so last write wins
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
      // Also verify disk has only one record
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

    it('getState reflects latest cache value without re-reading disk', async () => {
      await store.setState('gh', 'issue-1', 'unseen');

      // Mutate the file on disk behind the store's back
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, JSON.stringify([
        { providerId: 'gh', externalId: 'issue-1', inboxState: 'dismissed' },
      ]), 'utf-8');

      // getState should still return the cached value
      expect(store.getState('gh', 'issue-1')).toBe('unseen');
    });
  });

  // ── Rollback semantics ────────────────────────────────────────────

  describe('rollback on write failure', () => {
    it('setState rolls back cache when writeFile fails for a new item', async () => {
      await store.load();

      // Spy on the store's internal writeFile because fs.writeFile from ESM
      // fs/promises has non-configurable property descriptors and cannot be spied on.
      const writeSpy = vi.spyOn(store as any, 'writeFile').mockRejectedValueOnce(new Error('disk full'));

      await expect(store.setState('gh', 'issue-1', 'unseen')).rejects.toThrow('disk full');

      // Cache should not contain the failed item
      expect(store.getState('gh', 'issue-1')).toBeUndefined();

      writeSpy.mockRestore();
    });

    it('setState rolls back cache to previous value when writeFile fails for an existing item', async () => {
      await store.setState('gh', 'issue-1', 'unseen');

      const writeSpy = vi.spyOn(store as any, 'writeFile').mockRejectedValueOnce(new Error('disk full'));

      await expect(store.setState('gh', 'issue-1', 'accepted')).rejects.toThrow('disk full');

      // Should retain original value
      expect(store.getState('gh', 'issue-1')).toBe('unseen');

      writeSpy.mockRestore();
    });

    it('setStates rolls back all items when writeFile fails', async () => {
      await store.setState('gh', 'existing', 'unseen');

      const writeSpy = vi.spyOn(store as any, 'writeFile').mockRejectedValueOnce(new Error('I/O error'));

      await expect(store.setStates([
        { providerId: 'gh', externalId: 'existing', state: 'accepted' },
        { providerId: 'gh', externalId: 'brand-new', state: 'dismissed' },
      ])).rejects.toThrow('I/O error');

      // Existing item should keep old value
      expect(store.getState('gh', 'existing')).toBe('unseen');
      // New item should be removed from cache
      expect(store.getState('gh', 'brand-new')).toBeUndefined();

      writeSpy.mockRestore();
    });

    it('store remains functional after a failed write', async () => {
      await store.load();

      const writeSpy = vi.spyOn(store as any, 'writeFile').mockRejectedValueOnce(new Error('transient'));

      await expect(store.setState('gh', 'issue-1', 'unseen')).rejects.toThrow('transient');

      writeSpy.mockRestore();

      // Subsequent writes should succeed
      await store.setState('gh', 'issue-1', 'accepted');
      expect(store.getState('gh', 'issue-1')).toBe('accepted');

      const filePath = path.join(tmpDir, 'discovered-state.json');
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].inboxState).toBe('accepted');
    });

    it('onDidChange does not fire when setState fails', async () => {
      await store.load();

      const listener = vi.fn();
      store.onDidChange(listener);

      const writeSpy = vi.spyOn(store as any, 'writeFile').mockRejectedValueOnce(new Error('fail'));

      await expect(store.setState('gh', 'issue-1', 'unseen')).rejects.toThrow();

      expect(listener).not.toHaveBeenCalled();

      writeSpy.mockRestore();
    });

    it('onDidChange does not fire when setStates fails', async () => {
      await store.load();

      const listener = vi.fn();
      store.onDidChange(listener);

      const writeSpy = vi.spyOn(store as any, 'writeFile').mockRejectedValueOnce(new Error('fail'));

      await expect(store.setStates([
        { providerId: 'gh', externalId: 'a', state: 'unseen' },
      ])).rejects.toThrow();

      expect(listener).not.toHaveBeenCalled();

      writeSpy.mockRestore();
    });
  });

  // ── Concurrent operations ─────────────────────────────────────────

  describe('concurrent operations', () => {
    it('concurrent setState calls produce correct final state', async () => {
      // Pre-load to avoid lazy load race condition
      await store.load();

      const promises = [
        store.setState('gh', 'issue-1', 'unseen'),
        store.setState('gh', 'issue-2', 'accepted'),
        store.setState('gh', 'issue-3', 'dismissed'),
      ];

      await Promise.all(promises);

      expect(store.getState('gh', 'issue-1')).toBe('unseen');
      expect(store.getState('gh', 'issue-2')).toBe('accepted');
      expect(store.getState('gh', 'issue-3')).toBe('dismissed');

      // Verify all three are persisted
      const filePath = path.join(tmpDir, 'discovered-state.json');
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(3);
    });

    it('concurrent updates to the same key resolve to last-enqueued value', async () => {
      await store.load();

      const promises = [
        store.setState('gh', 'issue-1', 'unseen'),
        store.setState('gh', 'issue-1', 'accepted'),
        store.setState('gh', 'issue-1', 'dismissed'),
      ];

      await Promise.all(promises);

      // The last-enqueued call should win
      expect(store.getState('gh', 'issue-1')).toBe('dismissed');
      const records = await store.loadAll();
      expect(records).toHaveLength(1);
    });

    it('concurrent setState and setStates are serialized', async () => {
      await store.load();

      const promises = [
        store.setState('gh', 'issue-1', 'unseen'),
        store.setStates([
          { providerId: 'gh', externalId: 'issue-2', state: 'accepted' },
          { providerId: 'gh', externalId: 'issue-3', state: 'dismissed' },
        ]),
        store.setState('gh', 'issue-4', 'unseen'),
      ];

      await Promise.all(promises);

      expect(store.getState('gh', 'issue-1')).toBe('unseen');
      expect(store.getState('gh', 'issue-2')).toBe('accepted');
      expect(store.getState('gh', 'issue-3')).toBe('dismissed');
      expect(store.getState('gh', 'issue-4')).toBe('unseen');

      const records = await store.loadAll();
      expect(records).toHaveLength(4);
    });

    it('concurrent setStates batch calls are serialized', async () => {
      await store.load();

      const batch1 = Array.from({ length: 10 }, (_, i) => ({
        providerId: 'a', externalId: `a-${i}`, state: 'unseen' as const,
      }));
      const batch2 = Array.from({ length: 10 }, (_, i) => ({
        providerId: 'b', externalId: `b-${i}`, state: 'accepted' as const,
      }));

      await Promise.all([store.setStates(batch1), store.setStates(batch2)]);

      const records = await store.loadAll();
      expect(records).toHaveLength(20);
      expect(store.getState('a', 'a-0')).toBe('unseen');
      expect(store.getState('b', 'b-9')).toBe('accepted');
    });

    it('a failed write in a queue does not block subsequent operations', async () => {
      await store.load();

      const writeSpy = vi.spyOn(store as any, 'writeFile')
        .mockRejectedValueOnce(new Error('first fails'));

      const p1 = store.setState('gh', 'issue-1', 'unseen');
      const p2 = store.setState('gh', 'issue-2', 'accepted');

      await expect(p1).rejects.toThrow('first fails');

      writeSpy.mockRestore();

      await p2;

      // First should have been rolled back, second should succeed
      expect(store.getState('gh', 'issue-1')).toBeUndefined();
      expect(store.getState('gh', 'issue-2')).toBe('accepted');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('load is idempotent after first call', async () => {
      await store.setState('gh', 'issue-1', 'unseen');

      // load() again should not clear the cache (loaded flag is true)
      await store.load();
      expect(store.getState('gh', 'issue-1')).toBe('unseen');
    });

    it('setState triggers lazy load if not yet loaded', async () => {
      // Pre-populate the file
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, JSON.stringify([
        { providerId: 'gh', externalId: 'pre-existing', inboxState: 'unseen' },
      ]), 'utf-8');

      // setState without explicit load should still find pre-existing data
      await store.setState('gh', 'new-item', 'accepted');

      expect(store.getState('gh', 'pre-existing')).toBe('unseen');
      expect(store.getState('gh', 'new-item')).toBe('accepted');
    });

    it('setStates triggers lazy load if not yet loaded', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, JSON.stringify([
        { providerId: 'gh', externalId: 'pre-existing', inboxState: 'dismissed' },
      ]), 'utf-8');

      await store.setStates([
        { providerId: 'gh', externalId: 'new-item', state: 'unseen' },
      ]);

      expect(store.getState('gh', 'pre-existing')).toBe('dismissed');
      expect(store.getState('gh', 'new-item')).toBe('unseen');
    });

    it('handles special characters in providerId and externalId', async () => {
      const providerId = 'provider/with spaces-and-unicode-\u00df';
      const externalId = 'id/with/slashes?and=query#fragment';
      await store.setState(providerId, externalId, 'accepted');
      expect(store.getState(providerId, externalId)).toBe('accepted');
    });

    it('delimiter in ids causes key collision (documents limitation)', async () => {
      // The store keys on `providerId::externalId`, so these two
      // combinations collide: ("a::b", "c") vs ("a", "b::c").
      await store.setState('a::b', 'c', 'unseen');
      await store.setState('a', 'b::c', 'accepted');

      // Both map to key "a::b::c", so second write overwrites the first
      const records = await store.loadAll();
      expect(records).toHaveLength(1);
      expect(store.getState('a', 'b::c')).toBe('accepted');
      // The original entry is no longer retrievable correctly/uniquely
      // under its own ids; that lookup now returns the overwritten state.
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

      // First snapshot should not be affected by later mutations
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

      // After dispose, setState still works but listener should not fire
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

      // Verify a sampling of items
      expect(store.getState('gh', 'item-0')).toBe('unseen');
      expect(store.getState('gh', 'item-599')).toBe('unseen');
      expect(store.getState('gh', 'item-1199')).toBe('unseen');

      // Verify persistence by reloading from disk
      const store2 = new DiscoveredStateStore(tmpDir);
      await store2.load();
      const reloaded = await store2.loadAll();
      expect(reloaded).toHaveLength(1200);
      store2.dispose();
    });

    it('should update individual item states without affecting other entries', async () => {
      await store.setStates([
        { providerId: 'gh', externalId: 'keep-1', state: 'accepted' },
        { providerId: 'gh', externalId: 'update-1', state: 'unseen' },
        { providerId: 'gh', externalId: 'update-2', state: 'dismissed' },
        { providerId: 'gh', externalId: 'keep-2', state: 'accepted' },
      ]);
      expect((await store.loadAll())).toHaveLength(4);

      await store.setState('gh', 'update-1', 'dismissed');
      await store.setState('gh', 'update-2', 'accepted');

      expect(store.getState('gh', 'update-1')).toBe('dismissed');
      expect(store.getState('gh', 'update-2')).toBe('accepted');
      expect(store.getState('gh', 'keep-1')).toBe('accepted');
      expect(store.getState('gh', 'keep-2')).toBe('accepted');
    });

    it('should auto-load persisted data when setState is called before explicit load', async () => {
      // Pre-seed some data on disk
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, JSON.stringify([
        { providerId: 'gh', externalId: 'existing-1', inboxState: 'unseen' },
      ]), 'utf-8');

      // Create a fresh store and call setState without calling load() first
      const freshStore = new DiscoveredStateStore(tmpDir);
      await freshStore.setState('gh', 'new-1', 'accepted');

      expect(freshStore.getState('gh', 'existing-1')).toBe('unseen');
      expect(freshStore.getState('gh', 'new-1')).toBe('accepted');
      freshStore.dispose();
    });

    it('should handle corrupt JSON gracefully by backing up and loading empty', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, '{broken: json!!!', 'utf-8');

      await store.load();
      const records = await store.loadAll();
      expect(records).toEqual([]);

      const files = await fs.readdir(tmpDir);
      const backupFiles = files.filter(f => f.startsWith('discovered-state.json.corrupt.'));
      expect(backupFiles).toHaveLength(1);
    });

    it('should handle truncated JSON gracefully by backing up and loading empty', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, `[{"providerId":"gh","externalId":"1","inboxState":"unseen"`, 'utf-8');

      await store.load();
      const records = await store.loadAll();
      expect(records).toEqual([]);

      const files = await fs.readdir(tmpDir);
      const backupFiles = files.filter(f => f.startsWith('discovered-state.json.corrupt.'));
      expect(backupFiles).toHaveLength(1);
    });

    it('should handle empty file gracefully by backing up and loading empty', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, '', 'utf-8');

      await store.load();
      const records = await store.loadAll();
      expect(records).toEqual([]);

      const files = await fs.readdir(tmpDir);
      const backupFiles = files.filter(f => f.startsWith('discovered-state.json.corrupt.'));
      expect(backupFiles).toHaveLength(1);
    });

    it('should handle file containing only whitespace gracefully by backing up and loading empty', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, `   \n  `, 'utf-8');

      await store.load();
      const records = await store.loadAll();
      expect(records).toEqual([]);

      const files = await fs.readdir(tmpDir);
      const backupFiles = files.filter(f => f.startsWith('discovered-state.json.corrupt.'));
      expect(backupFiles).toHaveLength(1);
    });

    it('should look up all items correctly from a large set', async () => {
      const count = 2000;
      const items = Array.from({ length: count }, (_, i) => ({
        providerId: 'perf',
        externalId: `id-${i}`,
        state: 'unseen' as const,
      }));
      await store.setStates(items);

      for (let i = 0; i < count; i++) {
        expect(store.getState('perf', `id-${i}`)).toBe('unseen');
      }
    });

    it('should apply the last sequential state transition to an item', async () => {
      await store.setState('gh', 'flip', 'unseen');
      await store.setState('gh', 'flip', 'accepted');
      await store.setState('gh', 'flip', 'dismissed');

      expect(store.getState('gh', 'flip')).toBe('dismissed');

      const filePath = path.join(tmpDir, 'discovered-state.json');
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const flipEntries = parsed.filter((r: { externalId: string }) => r.externalId === 'flip');
      expect(flipEntries).toHaveLength(1);
    });

    it('should fire onDidChange for each setState in concurrent batch', async () => {
      const listener = vi.fn();
      store.onDidChange(listener);

      await Promise.all([
        store.setState('gh', 'x', 'unseen'),
        store.setState('gh', 'y', 'accepted'),
        store.setState('gh', 'z', 'dismissed'),
      ]);

      expect(listener).toHaveBeenCalledTimes(3);
    });
  });

  describe('file size limits', () => {
    afterEach(() => {
      mockLimits.MAX_STORE_FILE_SIZE = 10 * 1024 * 1024;
    });

    it('should back up and reset when file exceeds size limit', async () => {
      mockLimits.MAX_STORE_FILE_SIZE = 50;
      const filePath = path.join(tmpDir, 'discovered-state.json');
      const oversizedContent = JSON.stringify([
        { providerId: 'gh', externalId: 'issue-with-a-very-long-id-that-pushes-over', inboxState: 'unseen' },
      ]);
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(filePath, oversizedContent, 'utf-8');

      const records = await store.loadAll();
      expect(records).toEqual([]);

      const files = await fs.readdir(tmpDir);
      const backupFiles = files.filter(f => f.startsWith('discovered-state.json.corrupt.'));
      expect(backupFiles).toHaveLength(1);
    });

    it('should parse normally when file is just under size limit', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      const content = JSON.stringify([
        { providerId: 'gh', externalId: '1', inboxState: 'unseen' },
      ]);
      mockLimits.MAX_STORE_FILE_SIZE = content.length + 1;
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');

      const records = await store.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].providerId).toBe('gh');
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

    it('should persist version to disk', async () => {
      await store.setState('gh', 'pr-1', 'unseen', 'sha-abc');

      const filePath = path.join(tmpDir, 'discovered-state.json');
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed[0].version).toBe('sha-abc');
    });

    it('should load version from disk', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(filePath, JSON.stringify([
        { providerId: 'gh', externalId: 'pr-1', inboxState: 'accepted', version: 'sha-disk' },
      ]));

      const freshStore = new DiscoveredStateStore(tmpDir);
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
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(filePath, JSON.stringify([
        { providerId: 'gh', externalId: 'pr-1', inboxState: 'accepted', version: 42 },
        { providerId: 'gh', externalId: 'pr-2', inboxState: 'accepted', version: 'valid' },
      ]));

      const freshStore = new DiscoveredStateStore(tmpDir);
      const records = await freshStore.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('pr-2');
      freshStore.dispose();
    });
  });
});
