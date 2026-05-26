import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { JsonTaskStore } from '../storage/jsonTaskStore';
import { JsonFileStore } from '../storage/fileStore';
import { WorkItem, WorkItemState } from '../models/workItem';
import { useMockFileSystem, type MockFileSystem } from './testFileSystem';

describe('JsonTaskStore', () => {
  const fileUri = vscode.Uri.file('C:\\test\\workitems.json');
  let fileSystem: MockFileSystem;
  let store: JsonTaskStore;

  beforeEach(() => {
    vi.clearAllMocks();
    fileSystem = useMockFileSystem();
    store = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
  });

  afterEach(async () => {
    await store.flush();
    vi.useRealTimers();
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

  it('returns empty array when no data exists', async () => {
    const items = await store.loadAll();
    expect(items).toEqual([]);
  });

  it('saves and loads a work item', async () => {
    const item = makeItem();
    await store.save(item);

    const items = await store.loadAll();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('test-1');
    expect(items[0].title).toBe('Test item');
  });

  it('updates an existing item by id', async () => {
    const item = makeItem();
    await store.save(item);
    await store.save({ ...item, title: 'Updated title' });

    const items = await store.loadAll();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Updated title');
  });

  it('saves multiple items', async () => {
    await store.save(makeItem({ id: 'a' }));
    await store.save(makeItem({ id: 'b' }));

    const items = await store.loadAll();
    expect(items).toHaveLength(2);
  });

  it('deletes an item', async () => {
    await store.save(makeItem({ id: 'a' }));
    await store.save(makeItem({ id: 'b' }));
    await store.delete('a');

    const items = await store.loadAll();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('b');
  });

  it('delete is a no-op for unknown id', async () => {
    await store.save(makeItem({ id: 'a' }));
    await store.delete('nonexistent');

    const items = await store.loadAll();
    expect(items).toHaveLength(1);
  });

  describe('saveAll', () => {
    it('inserts multiple items in one call', async () => {
      const a = makeItem({ id: 'a', title: 'A' });
      const b = makeItem({ id: 'b', title: 'B' });
      await store.saveAll([a, b]);

      const items = await store.loadAll();
      expect(items).toHaveLength(2);
      expect(items.map(i => i.id).sort()).toEqual(['a', 'b']);
    });

    it('updates existing items', async () => {
      await store.save(makeItem({ id: 'a', title: 'Original A' }));
      await store.save(makeItem({ id: 'b', title: 'Original B' }));

      await store.saveAll([
        makeItem({ id: 'a', title: 'Updated A' }),
        makeItem({ id: 'b', title: 'Updated B' }),
      ]);

      const items = await store.loadAll();
      expect(items).toHaveLength(2);
      expect(items.find(i => i.id === 'a')!.title).toBe('Updated A');
      expect(items.find(i => i.id === 'b')!.title).toBe('Updated B');
    });

    it('handles a mix of inserts and updates', async () => {
      await store.save(makeItem({ id: 'existing', title: 'Old' }));

      await store.saveAll([
        makeItem({ id: 'existing', title: 'Updated' }),
        makeItem({ id: 'new-item', title: 'Brand New' }),
      ]);

      const items = await store.loadAll();
      expect(items).toHaveLength(2);
      expect(items.find(i => i.id === 'existing')!.title).toBe('Updated');
      expect(items.find(i => i.id === 'new-item')!.title).toBe('Brand New');
    });

    it('persists all items to the backing JSON file', async () => {
      await store.saveAll([
        makeItem({ id: 'x', title: 'X' }),
        makeItem({ id: 'y', title: 'Y' }),
      ]);
      await store.flush();

      const persisted = fileSystem.readJson<WorkItem[]>(fileUri);
      expect(persisted).toHaveLength(2);
      expect(persisted!.map((i: WorkItem) => i.id).sort()).toEqual(['x', 'y']);
    });

    it('preserves items not included in the saveAll call', async () => {
      await store.save(makeItem({ id: 'keep-me', title: 'Kept' }));

      await store.saveAll([makeItem({ id: 'added', title: 'Added' })]);

      const items = await store.loadAll();
      expect(items).toHaveLength(2);
      expect(items.find(i => i.id === 'keep-me')!.title).toBe('Kept');
      expect(items.find(i => i.id === 'added')!.title).toBe('Added');
    });
  });

  it('persists data to the backing JSON file', async () => {
    await store.save(makeItem());
    await store.flush();
    const persisted = fileSystem.readJson<WorkItem[]>(fileUri);
    expect(persisted).toHaveLength(1);
    expect(persisted![0].id).toBe('test-1');
  });

  it('loads from a fresh store instance sharing the same file', async () => {
    await store.save(makeItem({ id: 'a' }));
    await store.save(makeItem({ id: 'b' }));
    await store.flush();

    const store2 = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
    const items = await store2.loadAll();
    expect(items).toHaveLength(2);
  });

  describe('schema validation', () => {
    it('skips items missing an id', async () => {
      fileSystem.writeJson(fileUri, [
        { title: 'No ID', state: 'New', createdAt: 1000, updatedAt: 1000 },
        makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('skips items missing a title', async () => {
      fileSystem.writeJson(fileUri, [
        { id: 'no-title', state: 'New', createdAt: 1000, updatedAt: 1000 },
        makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('skips items with an invalid state', async () => {
      fileSystem.writeJson(fileUri, [
        { id: 'bad-state', title: 'Bad', state: 'InvalidState', createdAt: 1000, updatedAt: 1000 },
        makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('skips non-object entries', async () => {
      fileSystem.writeJson(fileUri, [
        'a string', 42, null, makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('returns empty when the backing JSON file contains a non-array', async () => {
      fileSystem.writeJson(fileUri, { not: 'an array' });

      const store2 = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
      const items = await store2.loadAll();
      expect(items).toEqual([]);
    });

    it('skips items missing createdAt', async () => {
      fileSystem.writeJson(fileUri, [
        { id: 'no-created', title: 'Missing ts', state: 'New', updatedAt: 1000 },
        makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('skips items with invalid optional fields', async () => {
      fileSystem.writeJson(fileUri, [
        { ...makeItem({ id: 'bad-url' }), url: 123 },
        { ...makeItem({ id: 'bad-provider' }), providerId: 42 },
        { ...makeItem({ id: 'bad-external' }), externalId: true },
        { ...makeItem({ id: 'bad-notes' }), notes: 999 },
        { ...makeItem({ id: 'bad-sort' }), sortOrder: 'abc' },
        makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('skips items with non-array activityLog', async () => {
      fileSystem.writeJson(fileUri, [
        { ...makeItem({ id: 'bad-log' }), activityLog: 'not an array' },
        makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('skips items with malformed activityLog entries', async () => {
      fileSystem.writeJson(fileUri, [
        { ...makeItem({ id: 'bad-entry' }), activityLog: [{ timestamp: 'not-a-number', type: 'created' }] },
        { ...makeItem({ id: 'missing-type' }), activityLog: [{ timestamp: 1000 }] },
        { ...makeItem({ id: 'null-entry' }), activityLog: [null] },
        { ...makeItem({ id: 'bad-detail' }), activityLog: [{ timestamp: 1000, type: 'created', detail: 42 }] },
        { ...makeItem({ id: 'good' }), activityLog: [{ timestamp: 1000, type: 'created' }] },
      ]);

      const store2 = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('good');
    });

    it('accepts items with valid activityLog', async () => {
      fileSystem.writeJson(fileUri, [
        {
          ...makeItem({ id: 'with-log' }),
          activityLog: [
            { timestamp: 1700000000000, type: 'created' },
            { timestamp: 1700001000000, type: 'state-changed', detail: 'New → InProgress' },
          ],
        },
      ]);

      const store2 = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].activityLog).toHaveLength(2);
    });
  });

  describe('persistence batching', () => {
    it('coalesces back-to-back mutations into a single disk write', async () => {
      vi.useFakeTimers();
      store = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'), { persistDelayMs: 25 });

      await store.save(makeItem({ id: 'batched', title: 'First', updatedAt: 1000 }));
      await store.save(makeItem({ id: 'batched', title: 'Second', updatedAt: 2000 }));

      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
      expect(vscode.workspace.fs.rename).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(25);
      await store.flush();

      const persisted = fileSystem.readJson<WorkItem[]>(fileUri)!;
      expect(persisted).toHaveLength(1);
      expect(persisted[0].title).toBe('Second');
      expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
      expect(vscode.workspace.fs.rename).toHaveBeenCalledTimes(1);
    });

    it('flushes queued mutations so a fresh store can load them after reactivation', async () => {
      const queuedStore = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'), { persistDelayMs: 60_000 });

      await queuedStore.save(makeItem({ id: 'queued', title: 'Queued update', updatedAt: 1000 }));
      expect(fileSystem.readJson<WorkItem[]>(fileUri)).toBeUndefined();

      await queuedStore.flush();

      const reactivatedStore = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
      const items = await reactivatedStore.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('queued');
      expect(items[0].title).toBe('Queued update');
    });

    it('surfaces persist failures from flush', async () => {
      const diskFull = new Error('disk full');
      (vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(diskFull);

      await store.save(makeItem({ id: 'failing-write', updatedAt: 1000 }));

      await expect(store.flush()).rejects.toThrow('disk full');
      expect(fileSystem.readJson<WorkItem[]>(fileUri)).toBeUndefined();

      await store.save(makeItem({ id: 'failing-write', title: 'Recovered', updatedAt: 2000 }));
      await store.flush();

      const persisted = fileSystem.readJson<WorkItem[]>(fileUri)!;
      expect(persisted).toHaveLength(1);
      expect(persisted[0].title).toBe('Recovered');
    });
  });

  describe('merge-on-write (multi-window safety)', () => {
    it('preserves items added by another window during persist', async () => {
      // Window A creates item1
      await store.save(makeItem({ id: 'item1', title: 'Window A item', updatedAt: 1000 }));
      await store.flush();

      // Simulate another window adding item2 directly to the shared JSON file
      const current = fileSystem.readJson<WorkItem[]>(fileUri) ?? [];
      fileSystem.writeJson(fileUri, [
        ...current,
        makeItem({ id: 'item2', title: 'Window B item', updatedAt: 2000 }),
      ]);

      // Window A saves item3 — should preserve item2 from remote
      await store.save(makeItem({ id: 'item3', title: 'Another A item', updatedAt: 3000 }));
      await store.flush();

      const persisted = fileSystem.readJson<WorkItem[]>(fileUri)!;
      expect(persisted).toHaveLength(3);
      expect(persisted.map(i => i.id).sort()).toEqual(['item1', 'item2', 'item3']);
    });

    it('keeps locally modified item when it has later updatedAt', async () => {
      await store.save(makeItem({ id: 'shared', title: 'Original', updatedAt: 1000 }));
      await store.flush();

      // Another window writes an older version
      fileSystem.writeJson(fileUri, [
        makeItem({ id: 'shared', title: 'Remote older', updatedAt: 500 }),
      ]);

      // Window A updates the item
      await store.save(makeItem({ id: 'shared', title: 'Local newer', updatedAt: 2000 }));
      await store.flush();

      const persisted = fileSystem.readJson<WorkItem[]>(fileUri)!;
      expect(persisted).toHaveLength(1);
      expect(persisted[0].title).toBe('Local newer');
    });

    it('takes remote item when it has later updatedAt', async () => {
      await store.save(makeItem({ id: 'shared', title: 'Original', updatedAt: 1000 }));
      await store.flush();

      // Another window writes a newer version
      fileSystem.writeJson(fileUri, [
        makeItem({ id: 'shared', title: 'Remote newer', updatedAt: 5000 }),
      ]);

      // Window A saves an unrelated item — merge should pick up remote's newer version
      await store.save(makeItem({ id: 'other', title: 'Other', updatedAt: 3000 }));
      await store.flush();

      const persisted = fileSystem.readJson<WorkItem[]>(fileUri)!;
      const shared = persisted.find(i => i.id === 'shared');
      expect(shared?.title).toBe('Remote newer');
    });

    it('does not restore locally deleted items from remote', async () => {
      await store.save(makeItem({ id: 'to-delete', title: 'Delete me', updatedAt: 1000 }));
      await store.flush();
      await store.delete('to-delete');
      await store.flush();

      // Remote still has the item (from before the delete)
      fileSystem.writeJson(fileUri, [
        makeItem({ id: 'to-delete', title: 'Still here', updatedAt: 1000 }),
      ]);

      // Window A saves something else — should not restore deleted item
      await store.save(makeItem({ id: 'new', title: 'New', updatedAt: 2000 }));
      await store.flush();

      const persisted = fileSystem.readJson<WorkItem[]>(fileUri)!;
      expect(persisted).toHaveLength(1);
      expect(persisted[0].id).toBe('new');
    });

    it('uses delete time when suppressing stale remote reintroductions', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-21T02:00:00Z'));

      await store.save(makeItem({ id: 'shared', title: 'Original', updatedAt: 1000 }));
      await store.flush();

      const windowB = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'));
      await windowB.loadAll();
      await windowB.save(makeItem({ id: 'shared', title: 'Remote update', updatedAt: 2000 }));
      await windowB.flush();

      await store.delete('shared');
      await store.flush();
      await store.save(makeItem({ id: 'other', title: 'Other', updatedAt: 3000 }));
      await store.flush();

      const persisted = fileSystem.readJson<WorkItem[]>(fileUri)!;
      expect(persisted.map(item => item.id).sort()).toEqual(['other']);

      vi.useRealTimers();
    });

    it('honors remote deletions for untouched items', async () => {
      await store.save(makeItem({ id: 'shared', title: 'Shared', updatedAt: 1000 }));
      await store.flush();

      // Another window deletes the item entirely.
      fileSystem.writeJson(fileUri, []);

      // This window only changes an unrelated item, so the deleted item should stay deleted.
      await store.save(makeItem({ id: 'other', title: 'Other', updatedAt: 2000 }));
      await store.flush();

      const persisted = fileSystem.readJson<WorkItem[]>(fileUri)!;
      expect(persisted).toHaveLength(1);
      expect(persisted[0].id).toBe('other');
    });

    it('keeps newer remote updates that arrive after a local delete', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-21T02:00:00Z'));

      await store.save(makeItem({ id: 'shared', title: 'Original', updatedAt: 1000 }));
      await store.flush();
      await store.delete('shared');
      await store.flush();

      fileSystem.writeJson(fileUri, [
        makeItem({ id: 'shared', title: 'Remote newer', updatedAt: Date.now() + 1 }),
      ]);

      await store.save(makeItem({ id: 'other', title: 'Other', updatedAt: Date.now() + 2 }));
      await store.flush();

      const persisted = fileSystem.readJson<WorkItem[]>(fileUri)!;
      expect(persisted.map(item => item.id).sort()).toEqual(['other', 'shared']);
      expect(persisted.find(item => item.id === 'shared')?.title).toBe('Remote newer');

      vi.useRealTimers();
    });

    it('rehydrates newer remote items into cache after a queued delete loses to a newer update', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-21T02:00:00Z'));
      store = new JsonTaskStore(new JsonFileStore(fileUri, 'workitems.json'), { persistDelayMs: 25 });

      await store.save(makeItem({ id: 'shared', title: 'Original', updatedAt: 1000 }));
      await store.flush();
      await store.delete('shared');

      fileSystem.writeJson(fileUri, [
        makeItem({ id: 'shared', title: 'Remote resurrected', updatedAt: Date.now() + 1 }),
      ]);

      await store.flush();

      const items = await store.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('shared');
      expect(items[0].title).toBe('Remote resurrected');

      vi.useRealTimers();
    });

    it('invalidateCache forces re-read on next access', async () => {
      await store.save(makeItem({ id: 'a', title: 'Original' }));
      await store.flush();

      // Another window modifies the data
      fileSystem.writeJson(fileUri, [
        makeItem({ id: 'a', title: 'Modified by other window' }),
      ]);

      await store.invalidateCache();
      const items = await store.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Modified by other window');
    });
  });
});
