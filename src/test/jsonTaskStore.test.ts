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

  it('persists data to a JSON file', async () => {
    await store.save(makeItem());
    const filePath = path.join(tmpDir, 'workitems.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('test-1');
  });
});
