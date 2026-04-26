import { describe, it, expect, beforeEach } from 'vitest';
import { MockMemento } from 'vscode';
import { ReadStateStore } from '../storage/readStateStore';

describe('ReadStateStore', () => {
  let memento: InstanceType<typeof MockMemento>;
  let store: ReadStateStore;

  beforeEach(() => {
    memento = new MockMemento();
    store = new ReadStateStore(memento);
  });

  it('should return false for has() when no data exists on load', async () => {
    await store.load();
    expect(store.has('gh::1')).toBe(false);
  });

  it('should add a key and persist to globalState', async () => {
    await store.load();
    expect(await store.add('gh::issue-1')).toBe(true);

    const persisted = memento.get<string[]>('devdocket.read-state');
    expect(persisted).toEqual(['gh::issue-1']);
  });

  it('should return false when adding a duplicate key', async () => {
    await store.load();
    expect(await store.add('gh::1')).toBe(true);
    expect(await store.add('gh::1')).toBe(false);
  });

  it('should report has() correctly after add', async () => {
    await store.load();
    expect(store.has('gh::1')).toBe(false);
    await store.add('gh::1');
    expect(store.has('gh::1')).toBe(true);
  });

  it('should deleteMany keys and persist', async () => {
    await store.load();
    await store.add('gh::1');
    await store.add('gh::2');
    await store.add('gh::3');
    await store.deleteMany(['gh::1', 'gh::3']);

    expect(store.has('gh::1')).toBe(false);
    expect(store.has('gh::2')).toBe(true);
    expect(store.has('gh::3')).toBe(false);

    const persisted = memento.get<string[]>('devdocket.read-state');
    expect(persisted).toEqual(['gh::2']);
  });

  it('should ignore non-existent keys in deleteMany', async () => {
    await store.load();
    await store.add('gh::1');
    await store.deleteMany(['gh::nonexistent']);

    expect(store.has('gh::1')).toBe(true);
  });

  it('should iterate keys', async () => {
    await store.load();
    await store.add('gh::1');
    await store.add('gh::2');
    const keys = [...store.keys()];
    expect(keys.sort()).toEqual(['gh::1', 'gh::2']);
  });

  it('should load persisted state from a fresh instance', async () => {
    await store.load();
    await store.add('gh::1');
    await store.add('jira::2');

    const store2 = new ReadStateStore(memento);
    await store2.load();
    expect(store2.has('gh::1')).toBe(true);
    expect(store2.has('jira::2')).toBe(true);
    expect(store2.has('gh::3')).toBe(false);
  });

  it('should skip non-string elements in the array', async () => {
    await memento.update('devdocket.read-state', ['valid::1', 42, null, true, 'valid::2', { obj: true }]);

    const store2 = new ReadStateStore(memento);
    await store2.load();
    const keys = [...store2.keys()].sort();
    expect(keys).toEqual(['valid::1', 'valid::2']);
  });

  it('should only load once (idempotent)', async () => {
    await store.load();
    await store.add('gh::1');

    // Second load should be a no-op
    await store.load();
    expect(store.has('gh::1')).toBe(true);
  });

  it('should auto-load when deleteMany() is called before load()', async () => {
    await memento.update('devdocket.read-state', ['gh::existing', 'gh::remove']);

    const freshStore = new ReadStateStore(memento);
    await freshStore.deleteMany(['gh::remove']);

    expect(freshStore.has('gh::existing')).toBe(true);
    expect(freshStore.has('gh::remove')).toBe(false);
  });

  it('should auto-load when add() is called before load()', async () => {
    await memento.update('devdocket.read-state', ['gh::existing']);

    const freshStore = new ReadStateStore(memento);
    await freshStore.add('gh::new');

    expect(freshStore.has('gh::existing')).toBe(true);
    expect(freshStore.has('gh::new')).toBe(true);
  });

  it('addMany returns newly added keys', async () => {
    await store.load();
    await store.add('gh::existing');

    const newlyAdded = await store.addMany(['gh::existing', 'gh::new-1', 'gh::new-2']);
    expect(newlyAdded.sort()).toEqual(['gh::new-1', 'gh::new-2']);

    expect(store.has('gh::existing')).toBe(true);
    expect(store.has('gh::new-1')).toBe(true);
    expect(store.has('gh::new-2')).toBe(true);
  });

  it('addMany with empty array returns empty', async () => {
    await store.load();
    const result = await store.addMany([]);
    expect(result).toEqual([]);
  });
});
