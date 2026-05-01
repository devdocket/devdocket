import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockMemento } from 'vscode';
import { ItemLinkStore } from '../storage/itemLinkStore';

describe('ItemLinkStore', () => {
  let memento: InstanceType<typeof MockMemento>;
  let store: ItemLinkStore;

  beforeEach(async () => {
    memento = new MockMemento();
    store = new ItemLinkStore(memento);
    await store.load();
  });

  afterEach(() => {
    store.dispose();
  });

  it('creates and persists a link', async () => {
    const result = await store.upsertLink('b', 'a', 'closes');

    expect(result.created).toBe(true);
    expect(result.link.itemId1).toBe('a');
    expect(result.link.itemId2).toBe('b');
    expect((await store.loadAll())).toHaveLength(1);
    expect(memento.get('devdocket.itemLinks')).toHaveLength(1);
  });

  it('deduplicates links regardless of item order', async () => {
    await store.upsertLink('a', 'b', 'linked');
    const result = await store.upsertLink('b', 'a', 'linked');

    expect(result.created).toBe(false);
    expect(result.updated).toBe(false);
    expect((await store.loadAll())).toHaveLength(1);
  });

  it('updates the relation for an existing link', async () => {
    await store.upsertLink('a', 'b', 'linked');
    const result = await store.upsertLink('a', 'b', 'closes');

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    expect(store.getLinkBetween('a', 'b')?.relation).toBe('closes');
  });

  it('returns all links for an item', async () => {
    await store.upsertLink('a', 'b', 'linked');
    await store.upsertLink('a', 'c', 'closes');

    expect(store.getLinksForItem('a')).toHaveLength(2);
    expect(store.getLinksForItem('b')).toHaveLength(1);
  });

  it('removes all links for a deleted item', async () => {
    await store.upsertLink('a', 'b', 'linked');
    await store.upsertLink('a', 'c', 'closes');

    const removed = await store.removeLinksForItem('a');

    expect(removed).toHaveLength(2);
    expect((await store.loadAll())).toEqual([]);
  });

  it('loads valid persisted links from a fresh store instance', async () => {
    await store.upsertLink('a', 'b', 'closes');

    const freshStore = new ItemLinkStore(memento);
    await freshStore.load();

    expect(freshStore.getLinkBetween('a', 'b')?.relation).toBe('closes');
    freshStore.dispose();
  });
});
