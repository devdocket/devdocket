import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { JsonTaskStore } from '../storage/jsonTaskStore';
import { DiscoveredStateStore, InboxState, DiscoveredStateRecord } from '../storage/discoveredStateStore';
import { WorkItem, WorkItemState } from '../models/workItem';

// Make fs/promises exports writable so vi.spyOn can mock writeFile
vi.mock('fs/promises', async (importOriginal) => {
  return { ...(await importOriginal<typeof import('fs/promises')>()) };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workcenter-concurrency-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'test-1',
    title: 'Test item',
    state: WorkItemState.New,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function readRawItems(dir: string): Promise<WorkItem[]> {
  const raw = await fs.readFile(path.join(dir, 'workitems.json'), 'utf-8');
  return JSON.parse(raw);
}

async function readRawDiscoveredState(dir: string): Promise<DiscoveredStateRecord[]> {
  const raw = await fs.readFile(path.join(dir, 'discovered-state.json'), 'utf-8');
  return JSON.parse(raw);
}

// ─── JsonTaskStore Concurrency ──────────────────────────────────────────────

describe('JsonTaskStore concurrency', () => {
  let store: JsonTaskStore;

  beforeEach(() => {
    store = new JsonTaskStore(tmpDir);
  });

  it('concurrent saves do not lose data', async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `item-${i}`, title: `Item ${i}` }),
    );

    // Fire all saves simultaneously
    await Promise.all(items.map((item) => store.save(item)));

    // Verify cache
    const cached = await store.loadAll();
    expect(cached).toHaveLength(10);
    for (const item of items) {
      expect(cached.find((c) => c.id === item.id)).toBeDefined();
    }

    // Verify disk
    const disk = await readRawItems(tmpDir);
    expect(disk).toHaveLength(10);
    for (const item of items) {
      expect(disk.find((d) => d.id === item.id)).toBeDefined();
    }
  });

  it('concurrent save and delete do not corrupt state', async () => {
    const itemA = makeItem({ id: 'a', title: 'Item A' });
    await store.save(itemA);

    const itemB = makeItem({ id: 'b', title: 'Item B' });

    // Simultaneously save B and delete A
    await Promise.all([store.save(itemB), store.delete('a')]);

    const cached = await store.loadAll();
    expect(cached.find((c) => c.id === 'a')).toBeUndefined();
    expect(cached.find((c) => c.id === 'b')).toBeDefined();

    const disk = await readRawItems(tmpDir);
    expect(disk.find((d) => d.id === 'a')).toBeUndefined();
    expect(disk.find((d) => d.id === 'b')).toBeDefined();
  });

  it('loadAll during an in-flight save returns the pre-save cached state', async () => {
    const item = makeItem({ id: 'x', title: 'Item X' });

    // Initialize the cache so loadAll() can overlap with the queued write
    await store.loadAll();

    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const writeStartedPromise = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });

    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: unknown[]) => {
      writeStarted();
      await writeBlocked;
      vi.mocked(fs.writeFile).mockRestore();
      return (fs.writeFile as Function)(...args);
    });

    const savePromise = store.save(item);
    await writeStartedPromise;

    try {
      // While save is blocked in writeFile, cache has not yet been updated
      // (cache.set happens after writeFile succeeds), so loadAll returns empty
      const loaded = await store.loadAll();
      expect(loaded).toHaveLength(0);
    } finally {
      releaseWrite();
      await savePromise;
    }

    // After the save completes, the item must be present
    const final = await store.loadAll();
    expect(final.find((i) => i.id === 'x')).toBeDefined();
  });

  it('multiple simultaneous saveAll calls preserve all items', async () => {
    const batch1 = [
      makeItem({ id: 'shared', title: 'Batch 1 version' }),
      makeItem({ id: 'only-1', title: 'Only in batch 1' }),
    ];
    const batch2 = [
      makeItem({ id: 'shared', title: 'Batch 2 version' }),
      makeItem({ id: 'only-2', title: 'Only in batch 2' }),
    ];

    // writeQueue serializes these: batch2 always runs after batch1
    await Promise.all([store.saveAll(batch1), store.saveAll(batch2)]);

    const cached = await store.loadAll();

    // Both unique items must exist
    expect(cached.find((c) => c.id === 'only-1')).toBeDefined();
    expect(cached.find((c) => c.id === 'only-2')).toBeDefined();

    // 'shared' takes the value from batch2 (serialized second)
    const shared = cached.find((c) => c.id === 'shared');
    expect(shared).toBeDefined();
    expect(shared!.title).toBe('Batch 2 version');

    // Disk must contain the same set of items as cache
    const disk = await readRawItems(tmpDir);
    const cachedIds = cached.map((c) => c.id).sort();
    const diskIds = disk.map((d) => d.id).sort();
    expect(diskIds).toEqual(cachedIds);
  });

  it('save after failed save recovers gracefully', async () => {
    const item1 = makeItem({ id: 'first', title: 'First' });
    const item2 = makeItem({ id: 'second', title: 'Second' });

    // Pre-load the store so cache is initialized
    await store.loadAll();

    let failNext = true;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: unknown[]) => {
      if (failNext) {
        failNext = false;
        throw new Error('Simulated disk failure');
      }
      // Restore and call real implementation
      vi.mocked(fs.writeFile).mockRestore();
      return fs.writeFile(...(args as Parameters<typeof fs.writeFile>));
    });

    // First save should fail
    await expect(store.save(item1)).rejects.toThrow('Simulated disk failure');

    // Cache should have rolled back — item1 should NOT be in the store
    const afterFail = await store.loadAll();
    expect(afterFail.find((i) => i.id === 'first')).toBeUndefined();

    // Second save should succeed (mock restored itself on first call)
    await store.save(item2);

    const final = await store.loadAll();
    expect(final.find((i) => i.id === 'second')).toBeDefined();
    expect(final.find((i) => i.id === 'first')).toBeUndefined();
  });
});

// ─── DiscoveredStateStore Concurrency ───────────────────────────────────────

describe('DiscoveredStateStore concurrency', () => {
  let store: DiscoveredStateStore;

  beforeEach(async () => {
    store = new DiscoveredStateStore(tmpDir);
    // Pre-load so concurrent setState calls don't trigger
    // multiple load() calls that race with cache.clear()
    await store.load();
  });

  afterEach(() => {
    store.dispose();
  });

  it('concurrent setState calls do not lose data', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      providerId: 'gh',
      externalId: `issue-${i}`,
      state: 'accepted' as InboxState,
    }));

    await Promise.all(
      entries.map((e) => store.setState(e.providerId, e.externalId, e.state)),
    );

    // Verify cache
    for (const e of entries) {
      expect(store.getState(e.providerId, e.externalId)).toBe('accepted');
    }

    // Verify disk
    const disk = await readRawDiscoveredState(tmpDir);
    expect(disk).toHaveLength(10);
    for (const e of entries) {
      expect(
        disk.find(
          (d) =>
            d.providerId === e.providerId && d.externalId === e.externalId,
        ),
      ).toBeDefined();
    }
  });

  it('concurrent setStates and setState do not lose data', async () => {
    const batchItems = Array.from({ length: 5 }, (_, i) => ({
      providerId: 'gh',
      externalId: `batch-${i}`,
      state: 'unseen' as InboxState,
    }));

    // Fire batch and single simultaneously
    await Promise.all([
      store.setStates(batchItems),
      store.setState('gh', 'single-1', 'accepted'),
      store.setState('gh', 'single-2', 'dismissed'),
    ]);

    // All batch items present
    for (const item of batchItems) {
      expect(store.getState(item.providerId, item.externalId)).toBe('unseen');
    }

    // Single items present
    expect(store.getState('gh', 'single-1')).toBe('accepted');
    expect(store.getState('gh', 'single-2')).toBe('dismissed');

    // Verify disk has exactly the expected persisted records
    const disk = await readRawDiscoveredState(tmpDir);
    const expectedRecords: Array<{ providerId: string; externalId: string; inboxState: InboxState }> = [
      ...batchItems.map((b) => ({ providerId: b.providerId, externalId: b.externalId, inboxState: b.state })),
      { providerId: 'gh', externalId: 'single-1', inboxState: 'accepted' },
      { providerId: 'gh', externalId: 'single-2', inboxState: 'dismissed' },
    ];
    expect(disk).toHaveLength(expectedRecords.length);
    for (const expected of expectedRecords) {
      expect(
        disk.find(
          (d) =>
            d.providerId === expected.providerId &&
            d.externalId === expected.externalId &&
            d.inboxState === expected.inboxState,
        ),
      ).toBeDefined();
    }
  });

  it('setState rolls back cache on write failure', async () => {
    // Seed initial state so file exists
    await store.setState('gh', 'existing', 'unseen');
    expect(store.getState('gh', 'existing')).toBe('unseen');

    // Mock writeFile to fail
    vi.spyOn(fs, 'writeFile').mockImplementation(async () => {
      throw new Error('Simulated write failure');
    });

    // Attempt setState — should fail and rollback
    await expect(store.setState('gh', 'new-item', 'accepted')).rejects.toThrow(
      'Simulated write failure',
    );

    // Cache should NOT contain the new item
    expect(store.getState('gh', 'new-item')).toBeUndefined();
    // Existing item should still be there
    expect(store.getState('gh', 'existing')).toBe('unseen');

    vi.restoreAllMocks();

    // After restoring, writes should work again
    await store.setState('gh', 'recovery', 'dismissed');
    expect(store.getState('gh', 'recovery')).toBe('dismissed');
  });

  it('setStates rolls back entire batch on write failure', async () => {
    await store.setState('gh', 'existing', 'unseen');

    vi.spyOn(fs, 'writeFile').mockImplementation(async () => {
      throw new Error('Simulated write failure');
    });

    const batchItems = [
      { providerId: 'gh', externalId: 'new-1', state: 'accepted' as InboxState },
      { providerId: 'gh', externalId: 'new-2', state: 'dismissed' as InboxState },
    ];

    await expect(store.setStates(batchItems)).rejects.toThrow('Simulated write failure');

    // Neither new item should be in cache
    expect(store.getState('gh', 'new-1')).toBeUndefined();
    expect(store.getState('gh', 'new-2')).toBeUndefined();
    // Existing item should still be intact
    expect(store.getState('gh', 'existing')).toBe('unseen');

    vi.restoreAllMocks();

    // Store should recover for subsequent operations
    await store.setState('gh', 'post-recovery', 'accepted');
    expect(store.getState('gh', 'post-recovery')).toBe('accepted');
  });
});
