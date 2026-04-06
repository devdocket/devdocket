import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { JsonTaskStore } from '../storage/jsonTaskStore';
import { WorkItem, WorkItemState } from '../models/workItem';

describe('JsonTaskStore', () => {
  let tmpDir: string;
  let store: JsonTaskStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workcenter-test-'));
    store = new JsonTaskStore(tmpDir);
  });

  afterEach(async () => {
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

  it('returns empty array when no file exists', async () => {
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

    it('persists all items to disk', async () => {
      await store.saveAll([
        makeItem({ id: 'x', title: 'X' }),
        makeItem({ id: 'y', title: 'Y' }),
      ]);

      const filePath = path.join(tmpDir, 'workitems.json');
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(2);
      expect(parsed.map((i: WorkItem) => i.id).sort()).toEqual(['x', 'y']);
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

  it('persists data to a JSON file', async () => {
    await store.save(makeItem());
    const filePath = path.join(tmpDir, 'workitems.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('test-1');
  });

  it('migrates legacy description field to notes on load', async () => {
    const filePath = path.join(tmpDir, 'workitems.json');
    const legacy = [{
      id: 'legacy-1',
      title: 'Old item',
      description: 'Legacy description',
      state: 'New',
      createdAt: 1000,
      updatedAt: 1000,
    }];
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(legacy), 'utf-8');

    const items = await store.loadAll();
    expect(items).toHaveLength(1);
    expect(items[0].notes).toBe('Legacy description');
    expect((items[0] as any).description).toBeUndefined();
  });

  it('persists migrated description→notes back to disk', async () => {
    const filePath = path.join(tmpDir, 'workitems.json');
    const legacy = [{
      id: 'legacy-1',
      title: 'Old item',
      description: 'Legacy description',
      state: 'New',
      createdAt: 1000,
      updatedAt: 1000,
    }];
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(legacy), 'utf-8');

    await store.loadAll();

    const raw = await fs.readFile(filePath, 'utf-8');
    const persisted = JSON.parse(raw);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].notes).toBe('Legacy description');
    expect(persisted[0].description).toBeUndefined();
  });

  it('migrates legacy Blocked state to Paused on load', async () => {
    const filePath = path.join(tmpDir, 'workitems.json');
    const legacy = [{
      id: 'blocked-1',
      title: 'Blocked item',
      state: 'Blocked',
      createdAt: 1000,
      updatedAt: 1000,
    }];
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(legacy), 'utf-8');

    const items = await store.loadAll();
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe(WorkItemState.Paused);
  });

  it('migrates legacy WaitingOn state to Paused on load', async () => {
    const filePath = path.join(tmpDir, 'workitems.json');
    const legacy = [{
      id: 'waiting-1',
      title: 'Waiting item',
      state: 'WaitingOn',
      createdAt: 1000,
      updatedAt: 1000,
    }];
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(legacy), 'utf-8');

    const items = await store.loadAll();
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe(WorkItemState.Paused);
  });

  it('persists migrated Blocked/WaitingOn→Paused back to disk', async () => {
    const filePath = path.join(tmpDir, 'workitems.json');
    const legacy = [
      { id: 'b-1', title: 'Blocked', state: 'Blocked', createdAt: 1000, updatedAt: 1000 },
      { id: 'w-1', title: 'Waiting', state: 'WaitingOn', createdAt: 1000, updatedAt: 1000 },
    ];
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(legacy), 'utf-8');

    await store.loadAll();

    const raw = await fs.readFile(filePath, 'utf-8');
    const persisted = JSON.parse(raw);
    expect(persisted).toHaveLength(2);
    expect(persisted[0].state).toBe(WorkItemState.Paused);
    expect(persisted[1].state).toBe(WorkItemState.Paused);
  });
});
