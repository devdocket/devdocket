import { describe, it, expect, beforeEach } from 'vitest';
import { Registry } from '../services/registry';

interface TestItem {
  readonly id: string;
  readonly label: string;
}

function createItem(id: string, label = `Item ${id}`): TestItem {
  return { id, label };
}

describe('Registry', () => {
  let registry: Registry<TestItem>;

  beforeEach(() => {
    registry = new Registry<TestItem>('Test');
  });

  it('registers an item and retrieves it by id', () => {
    const item = createItem('a');
    registry.register(item);
    expect(registry.get('a')).toBe(item);
  });

  it('returns undefined for unknown id', () => {
    expect(registry.get('missing')).toBeUndefined();
  });

  it('has() returns true for registered and false for missing', () => {
    registry.register(createItem('x'));
    expect(registry.has('x')).toBe(true);
    expect(registry.has('y')).toBe(false);
  });

  it('getAll() returns all registered items', () => {
    const a = createItem('a');
    const b = createItem('b');
    registry.register(a);
    registry.register(b);
    expect(registry.getAll()).toEqual(expect.arrayContaining([a, b]));
    expect(registry.getAll()).toHaveLength(2);
  });

  it('size reflects the number of registered items', () => {
    expect(registry.size).toBe(0);
    registry.register(createItem('a'));
    expect(registry.size).toBe(1);
    registry.register(createItem('b'));
    expect(registry.size).toBe(2);
  });

  it('throws on duplicate id', () => {
    registry.register(createItem('dup'));
    expect(() => registry.register(createItem('dup'))).toThrow('Test already registered: dup');
  });

  it('disposing the returned Disposable removes the item', () => {
    const disposable = registry.register(createItem('removable'));
    expect(registry.has('removable')).toBe(true);
    disposable.dispose();
    expect(registry.has('removable')).toBe(false);
    expect(registry.get('removable')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('allows re-registration after disposal', () => {
    const disposable = registry.register(createItem('reuse'));
    disposable.dispose();
    const item2 = createItem('reuse', 'Reused');
    registry.register(item2);
    expect(registry.get('reuse')).toBe(item2);
  });

  it('disposing the first registration after re-registering the same id does not remove the new item', () => {
    const item1 = createItem('reuse', 'Original');
    const disposable1 = registry.register(item1);

    disposable1.dispose();

    const item2 = createItem('reuse', 'Reused');
    registry.register(item2);

    disposable1.dispose();

    expect(registry.get('reuse')).toBe(item2);
    expect(registry.has('reuse')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('clear() removes all items', () => {
    registry.register(createItem('a'));
    registry.register(createItem('b'));
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.getAll()).toHaveLength(0);
  });
});
