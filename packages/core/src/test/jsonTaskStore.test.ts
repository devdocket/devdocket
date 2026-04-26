import { describe, it, expect, beforeEach } from 'vitest';
import { MockMemento } from 'vscode';
import { JsonTaskStore } from '../storage/jsonTaskStore';
import { WorkItem, WorkItemState } from '../models/workItem';

describe('JsonTaskStore', () => {
  let memento: InstanceType<typeof MockMemento>;
  let store: JsonTaskStore;

  beforeEach(() => {
    memento = new MockMemento();
    store = new JsonTaskStore(memento);
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

    it('persists all items to globalState', async () => {
      await store.saveAll([
        makeItem({ id: 'x', title: 'X' }),
        makeItem({ id: 'y', title: 'Y' }),
      ]);

      const persisted = memento.get<WorkItem[]>('devdocket.workitems');
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

  it('persists data to globalState', async () => {
    await store.save(makeItem());
    const persisted = memento.get<WorkItem[]>('devdocket.workitems');
    expect(persisted).toHaveLength(1);
    expect(persisted![0].id).toBe('test-1');
  });

  it('loads from a fresh store instance sharing same Memento', async () => {
    await store.save(makeItem({ id: 'a' }));
    await store.save(makeItem({ id: 'b' }));

    const store2 = new JsonTaskStore(memento);
    const items = await store2.loadAll();
    expect(items).toHaveLength(2);
  });

  describe('schema validation', () => {
    it('skips items missing an id', async () => {
      await memento.update('devdocket.workitems', [
        { title: 'No ID', state: 'New', createdAt: 1000, updatedAt: 1000 },
        makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(memento);
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('skips items missing a title', async () => {
      await memento.update('devdocket.workitems', [
        { id: 'no-title', state: 'New', createdAt: 1000, updatedAt: 1000 },
        makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(memento);
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('skips items with an invalid state', async () => {
      await memento.update('devdocket.workitems', [
        { id: 'bad-state', title: 'Bad', state: 'InvalidState', createdAt: 1000, updatedAt: 1000 },
        makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(memento);
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('skips non-object entries', async () => {
      await memento.update('devdocket.workitems', [
        'a string', 42, null, makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(memento);
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('returns empty when globalState contains a non-array', async () => {
      await memento.update('devdocket.workitems', { not: 'an array' });

      const store2 = new JsonTaskStore(memento);
      const items = await store2.loadAll();
      expect(items).toEqual([]);
    });

    it('skips items missing createdAt', async () => {
      await memento.update('devdocket.workitems', [
        { id: 'no-created', title: 'Missing ts', state: 'New', updatedAt: 1000 },
        makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(memento);
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('skips items with invalid optional fields', async () => {
      await memento.update('devdocket.workitems', [
        { ...makeItem({ id: 'bad-url' }), url: 123 },
        { ...makeItem({ id: 'bad-provider' }), providerId: 42 },
        { ...makeItem({ id: 'bad-external' }), externalId: true },
        { ...makeItem({ id: 'bad-notes' }), notes: 999 },
        { ...makeItem({ id: 'bad-sort' }), sortOrder: 'abc' },
        makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(memento);
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('skips items with non-array activityLog', async () => {
      await memento.update('devdocket.workitems', [
        { ...makeItem({ id: 'bad-log' }), activityLog: 'not an array' },
        makeItem({ id: 'valid' }),
      ]);

      const store2 = new JsonTaskStore(memento);
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('valid');
    });

    it('skips items with malformed activityLog entries', async () => {
      await memento.update('devdocket.workitems', [
        { ...makeItem({ id: 'bad-entry' }), activityLog: [{ timestamp: 'not-a-number', type: 'created' }] },
        { ...makeItem({ id: 'missing-type' }), activityLog: [{ timestamp: 1000 }] },
        { ...makeItem({ id: 'null-entry' }), activityLog: [null] },
        { ...makeItem({ id: 'bad-detail' }), activityLog: [{ timestamp: 1000, type: 'created', detail: 42 }] },
        { ...makeItem({ id: 'good' }), activityLog: [{ timestamp: 1000, type: 'created' }] },
      ]);

      const store2 = new JsonTaskStore(memento);
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('good');
    });

    it('accepts items with valid activityLog', async () => {
      await memento.update('devdocket.workitems', [
        {
          ...makeItem({ id: 'with-log' }),
          activityLog: [
            { timestamp: 1700000000000, type: 'created' },
            { timestamp: 1700001000000, type: 'state-changed', detail: 'New → InProgress' },
          ],
        },
      ]);

      const store2 = new JsonTaskStore(memento);
      const items = await store2.loadAll();
      expect(items).toHaveLength(1);
      expect(items[0].activityLog).toHaveLength(2);
    });
  });
});
