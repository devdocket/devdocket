import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ProviderItem } from '../api/types';
import { ReadStateStore } from '../storage/readStateStore';
import { JsonFileStore } from '../storage/fileStore';
import { logger } from '../services/logger';
import { useMockFileSystem, type MockFileSystem } from './testFileSystem';

describe('ReadStateStore', () => {
  const fileUri = vscode.Uri.file('C:\\test\\read-state.json');
  let fileSystem: MockFileSystem;
  let store: ReadStateStore;

  const persistedRecords = () => fileSystem.readJson<Array<{ key: string; createdAt?: number }>>(fileUri) ?? [];
  const persistedKeys = () => persistedRecords().map(record => record.key);

  beforeEach(() => {
    vi.clearAllMocks();
    fileSystem = useMockFileSystem();
    store = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
  });

  afterEach(() => {
    store.dispose();
  });

  it('should return false for has() when no data exists on load', async () => {
    await store.load();
    expect(store.has('gh::1')).toBe(false);
  });

  it('should add a key and persist to the file store', async () => {
    await store.load();
    expect(await store.add('gh::issue-1')).toBe(true);

    const persisted = persistedRecords();
    expect(persisted).toEqual([{ key: 'gh::issue-1', createdAt: expect.any(Number) }]);
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

    const persisted = persistedRecords();
    expect(persisted).toEqual([{ key: 'gh::2', createdAt: expect.any(Number) }]);
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

    const store2 = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
    await store2.load();
    expect(store2.has('gh::1')).toBe(true);
    expect(store2.has('jira::2')).toBe(true);
    expect(store2.has('gh::3')).toBe(false);
  });

  it('persists createdAt timestamps for new keys', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(4_321);

    try {
      await store.load();
      await store.add('gh::timed');
    } finally {
      nowSpy.mockRestore();
    }

    expect(persistedRecords()).toEqual([{ key: 'gh::timed', createdAt: 4_321 }]);
  });

  it('preserves createdAt timestamps across reload and rewrite', async () => {
    fileSystem.writeJson(fileUri, [{ key: 'gh::legacy', createdAt: 123 }]);

    const store2 = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
    await store2.load();
    await store2.add('gh::new');

    expect(persistedRecords()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'gh::legacy', createdAt: 123 }),
      expect.objectContaining({ key: 'gh::new', createdAt: expect.any(Number) }),
    ]));
    store2.dispose();
  });

  it('loads legacy string entries without createdAt timestamps', async () => {
    fileSystem.writeJson(fileUri, ['gh::legacy']);

    const store2 = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
    await store2.load();

    expect(store2.has('gh::legacy')).toBe(true);
    store2.dispose();
  });

  it('should skip non-string elements in the array', async () => {
    fileSystem.writeJson(fileUri, ['valid::1', 42, null, true, 'valid::2', { obj: true }]);

    const store2 = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
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
    fileSystem.writeJson(fileUri, ['gh::existing', 'gh::remove']);

    const freshStore = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
    await freshStore.deleteMany(['gh::remove']);

    expect(freshStore.has('gh::existing')).toBe(true);
    expect(freshStore.has('gh::remove')).toBe(false);
  });

  it('should auto-load when add() is called before load()', async () => {
    fileSystem.writeJson(fileUri, ['gh::existing']);

    const freshStore = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
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

  it('addMany only returns newly added keys that remain after capacity trimming', async () => {
    let currentTime = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime++);

    try {
      await store.load();
      await store.addMany(Array.from({ length: 4_999 }, (_, i) => `gh::seed-${i}`));
      const retained = await store.addMany(Array.from({ length: 10 }, (_, i) => `gh::new-${i}`));

      expect(retained).toEqual(Array.from({ length: 10 }, (_, i) => `gh::new-${i}`));
    } finally {
      nowSpy.mockRestore();
    }
  });

  describe('merge-on-write', () => {
    it('preserves remote additions while persisting local changes', async () => {
      const windowA = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
      const windowB = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
      await windowA.load();

      await windowB.add('gh::remote');
      await windowA.add('gh::local');

      expect(persistedKeys().sort()).toEqual(['gh::local', 'gh::remote']);

      windowA.dispose();
      windowB.dispose();
    });

    it('keeps locally removed keys deleted while preserving remote additions', async () => {
      fileSystem.writeJson(fileUri, ['gh::keep', 'gh::remove']);

      const windowA = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
      const windowB = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
      await windowA.load();
      await windowB.load();

      await windowB.add('gh::remote');
      await windowA.deleteMany(['gh::remove']);

      expect([...windowA.keys()].sort()).toEqual(['gh::keep', 'gh::remote']);
      expect(persistedKeys().sort()).toEqual(['gh::keep', 'gh::remote']);

      windowA.dispose();
      windowB.dispose();
    });

    it('allows remote re-additions after a successful persist', async () => {
      fileSystem.writeJson(fileUri, ['gh::shared']);

      const windowA = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
      await windowA.load();

      await windowA.deleteMany(['gh::shared']);

      const windowB = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
      await windowB.load();
      await windowB.add('gh::shared');

      await windowA.add('gh::local');

      expect(persistedKeys().sort()).toEqual(['gh::local', 'gh::shared']);

      windowA.dispose();
      windowB.dispose();
    });

    it('invalidateCache forces a re-read on next load', async () => {
      await store.add('gh::issue-1');

      fileSystem.writeJson(fileUri, ['gh::issue-2']);

      store.invalidateCache();
      await store.load();

      expect([...store.keys()]).toEqual(['gh::issue-2']);
    });
  });

  describe('capacity management', () => {
    it('caps persisted keys and evicts the oldest keys first on write', async () => {
      let currentTime = 0;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime++);

      try {
        await store.load();
        const retained = await store.addMany(Array.from({ length: 6_000 }, (_, i) => `gh::issue-${i}`));

        expect(retained).toEqual(Array.from({ length: 5_000 }, (_, i) => `gh::issue-${i + 1_000}`));
      } finally {
        nowSpy.mockRestore();
      }

      expect([...store.keys()]).toHaveLength(5_000);
      expect(persistedRecords()).toHaveLength(5_000);
      expect(store.has('gh::issue-0')).toBe(false);
      expect(store.has('gh::issue-999')).toBe(false);
      expect(store.has('gh::issue-1000')).toBe(true);
      expect(store.has('gh::issue-5999')).toBe(true);
    });

    it('trims oversized persisted read state on load and logs once', async () => {
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      fileSystem.writeJson(fileUri, Array.from({ length: 6_000 }, (_, i) => ({
        key: `gh::issue-${i}`,
        createdAt: i,
      })));

      const store2 = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
      await store2.load();

      expect([...store2.keys()]).toHaveLength(5_000);
      expect(persistedRecords()).toHaveLength(5_000);
      expect(store2.has('gh::issue-0')).toBe(false);
      expect(store2.has('gh::issue-1000')).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Trimmed read-state.json from 6000 to 5000 entries while loading'));
      store2.dispose();
      infoSpy.mockRestore();
    });

    it('does not resurrect keys evicted by another window', async () => {
      const windowA = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
      const windowB = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));

      fileSystem.writeJson(fileUri, Array.from({ length: 6_000 }, (_, i) => ({
        key: `gh::issue-${i}`,
        createdAt: i,
      })));

      await windowA.load();
      await windowB.load();
      await windowA.add('gh::fresh');
      await windowB.add('gh::another-fresh');

      expect(persistedKeys()).not.toContain('gh::issue-0');
      expect(persistedKeys()).not.toContain('gh::issue-999');
      expect(persistedKeys()).toContain('gh::fresh');
      expect(persistedKeys()).toContain('gh::another-fresh');

      windowA.dispose();
      windowB.dispose();
    });
  });

  describe('prune', () => {
    it('removes only stale keys belonging to providers that returned items', async () => {
      await store.addMany(['gh::keep', 'gh::stale', 'jira::stale']);

      const activeItems = new Map<string, ProviderItem[]>([
        ['gh', [{ externalId: 'keep', title: 'Keep' }]],
      ]);

      const pruned = await store.prune(activeItems);

      expect(pruned).toBe(1);
      expect(store.has('gh::keep')).toBe(true);
      expect(store.has('gh::stale')).toBe(false);
      expect(store.has('jira::stale')).toBe(true);
    });

    it('skips providers whose item array is empty', async () => {
      await store.add('gh::stale');

      const activeItems = new Map<string, ProviderItem[]>([
        ['gh', []],
      ]);

      const pruned = await store.prune(activeItems);

      expect(pruned).toBe(0);
      expect(store.has('gh::stale')).toBe(true);
    });

    it('returns 0 and does not fire onDidChange when no providers returned items', async () => {
      await store.addMany(['gh::stale', 'jira::stale']);
      const listener = vi.fn();
      store.onDidChange(listener);

      const activeItems = new Map<string, ProviderItem[]>([
        ['gh', []],
        ['jira', []],
      ]);

      const pruned = await store.prune(activeItems);

      expect(pruned).toBe(0);
      expect(listener).not.toHaveBeenCalled();
      expect(store.has('gh::stale')).toBe(true);
      expect(store.has('jira::stale')).toBe(true);
    });

    it('returns 0 and does not fire onDidChange when nothing is stale', async () => {
      await store.addMany(['gh::keep-1', 'gh::keep-2']);
      const listener = vi.fn();
      store.onDidChange(listener);

      const activeItems = new Map<string, ProviderItem[]>([
        ['gh', [
          { externalId: 'keep-1', title: 'Keep 1' },
          { externalId: 'keep-2', title: 'Keep 2' },
        ]],
      ]);

      const pruned = await store.prune(activeItems);

      expect(pruned).toBe(0);
      expect(listener).not.toHaveBeenCalled();
    });

    it('fires onDidChange exactly once when one or more keys are removed', async () => {
      await store.addMany(['gh::keep', 'gh::stale-1', 'gh::stale-2']);
      const listener = vi.fn();
      store.onDidChange(listener);

      const activeItems = new Map<string, ProviderItem[]>([
        ['gh', [{ externalId: 'keep', title: 'Keep' }]],
      ]);

      const pruned = await store.prune(activeItems);

      expect(pruned).toBe(2);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('lazy-loads on first call', async () => {
      fileSystem.writeJson(fileUri, ['gh::keep', 'gh::stale']);

      const freshStore = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
      const activeItems = new Map<string, ProviderItem[]>([
        ['gh', [{ externalId: 'keep', title: 'Keep' }]],
      ]);

      const pruned = await freshStore.prune(activeItems);

      expect(pruned).toBe(1);
      expect(freshStore.has('gh::keep')).toBe(true);
      expect(freshStore.has('gh::stale')).toBe(false);
      expect(persistedKeys()).toEqual(['gh::keep']);
      freshStore.dispose();
    });

    it('ignores legacy stored keys without the provider delimiter', async () => {
      fileSystem.writeJson(fileUri, ['legacy-key', 'gh::stale']);

      const freshStore = new ReadStateStore(new JsonFileStore(fileUri, 'read-state.json'));
      const activeItems = new Map<string, ProviderItem[]>([
        ['gh', [{ externalId: 'keep', title: 'Keep' }]],
      ]);

      const pruned = await freshStore.prune(activeItems);

      expect(pruned).toBe(1);
      expect([...freshStore.keys()]).toEqual(['legacy-key']);
      expect(persistedKeys()).toEqual(['legacy-key']);
      freshStore.dispose();
    });

    it('scopes per-provider when another provider returned no items', async () => {
      await store.addMany(['provider-a::keep', 'provider-a::stale', 'provider-b::stale']);

      const activeItems = new Map<string, ProviderItem[]>([
        ['provider-a', [{ externalId: 'keep', title: 'Keep' }]],
        ['provider-b', []],
      ]);

      const pruned = await store.prune(activeItems);

      expect(pruned).toBe(1);
      expect(store.has('provider-a::keep')).toBe(true);
      expect(store.has('provider-a::stale')).toBe(false);
      expect(store.has('provider-b::stale')).toBe(true);
    });
  });
});
