import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';

describe('DiscoveredStateStore', () => {
  let tmpDir: string;
  let store: DiscoveredStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workcenter-state-test-'));
    store = new DiscoveredStateStore(tmpDir);
  });

  afterEach(async () => {
    store.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

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

  it('should handle corrupted JSON by throwing', async () => {
    const filePath = path.join(tmpDir, 'discovered-state.json');
    await fs.writeFile(filePath, 'not valid json', 'utf-8');

    await expect(store.load()).rejects.toThrow();
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

  describe('edge cases', () => {
    it('should handle concurrent setState calls without data loss', async () => {
      // Pre-load so concurrent setState calls don't race on load()
      await store.load();
      const promises = Array.from({ length: 20 }, (_, i) =>
        store.setState('gh', `issue-${i}`, 'unseen')
      );
      await Promise.all(promises);

      const records = await store.loadAll();
      expect(records).toHaveLength(20);
      for (let i = 0; i < 20; i++) {
        expect(store.getState('gh', `issue-${i}`)).toBe('unseen');
      }
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

      // Transition individual items to new states
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

    it('should throw on corrupt JSON (non-parseable)', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, '{broken: json!!!', 'utf-8');

      await expect(store.load()).rejects.toThrow();
    });

    it('should throw on truncated JSON', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, '[{"providerId":"gh","externalId":"1","inboxState":"unseen"', 'utf-8');

      await expect(store.load()).rejects.toThrow();
    });

    it('should handle empty file as corrupt JSON', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, '', 'utf-8');

      await expect(store.load()).rejects.toThrow();
    });

    it('should handle file containing only whitespace as corrupt JSON', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, '   \n  ', 'utf-8');

      await expect(store.load()).rejects.toThrow();
    });

    it('should serialize concurrent save calls via write queue', async () => {
      // Pre-load so concurrent setState calls don't race on load()
      await store.load();
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        promises.push(store.setState('gh', `concurrent-${i}`, 'unseen'));
      }
      await Promise.all(promises);

      // All items must be present after serialized writes
      const records = await store.loadAll();
      expect(records).toHaveLength(50);

      // Verify the file on disk is valid JSON with all entries
      const filePath = path.join(tmpDir, 'discovered-state.json');
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(50);
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

    it('should handle concurrent setStates batch calls', async () => {
      // Pre-load so concurrent setStates calls don't race on load()
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

    it('should handle rapid state transitions on the same item', async () => {
      await Promise.all([
        store.setState('gh', 'flip', 'unseen'),
        store.setState('gh', 'flip', 'accepted'),
        store.setState('gh', 'flip', 'dismissed'),
      ]);

      // The final state depends on write-queue ordering; all three are valid
      const finalState = store.getState('gh', 'flip');
      expect(['unseen', 'accepted', 'dismissed']).toContain(finalState);

      // Only one record for this key
      const records = await store.loadAll();
      const flipRecords = records.filter(r => r.externalId === 'flip');
      expect(flipRecords).toHaveLength(1);
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
});
