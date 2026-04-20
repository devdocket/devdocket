import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { WatchStore } from '../storage/watchStore';
import type { WatchedRun } from '../services/watcherService';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createTestWatch(overrides?: Partial<WatchedRun>): WatchedRun {
  return {
    identifier: {
      providerId: 'github-actions',
      runId: '123',
      displayName: 'CI Build',
      url: 'https://github.com/owner/repo/actions/runs/123',
      repo: 'owner/repo',
    },
    status: { overallState: 'running', jobs: [] },
    watchedAt: '2026-01-01T00:00:00Z',
    lastPolledAt: '2026-01-01T00:00:00Z',
    dismissed: false,
    ...overrides,
  };
}

describe('WatchStore', () => {
  const testDir = path.join(process.cwd(), '.test-watch-store-' + process.pid);
  let store: WatchStore;

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    store = new WatchStore(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('loadAll', () => {
    it('returns empty array when file does not exist', async () => {
      const result = await store.loadAll();
      expect(result).toEqual([]);
    });

    it('loads valid watches from disk', async () => {
      const watch = createTestWatch();
      await fs.writeFile(
        path.join(testDir, 'watches.json'),
        JSON.stringify([watch]),
        'utf-8',
      );

      const result = await store.loadAll();
      expect(result).toHaveLength(1);
      expect(result[0].identifier.runId).toBe('123');
    });

    it('returns empty array for non-array JSON', async () => {
      await fs.writeFile(
        path.join(testDir, 'watches.json'),
        '{"not": "an array"}',
        'utf-8',
      );

      const result = await store.loadAll();
      expect(result).toEqual([]);
    });

    it('returns empty array for invalid JSON', async () => {
      await fs.writeFile(
        path.join(testDir, 'watches.json'),
        'not valid json {{{',
        'utf-8',
      );

      const result = await store.loadAll();
      expect(result).toEqual([]);
    });

    it('filters out entries missing required fields', async () => {
      const valid = createTestWatch();
      const invalid = { foo: 'bar' };
      await fs.writeFile(
        path.join(testDir, 'watches.json'),
        JSON.stringify([valid, invalid]),
        'utf-8',
      );

      const result = await store.loadAll();
      expect(result).toHaveLength(1);
    });
  });

  describe('saveAll', () => {
    it('saves watches to disk', async () => {
      const watch = createTestWatch();
      await store.saveAll([watch]);

      const data = await fs.readFile(path.join(testDir, 'watches.json'), 'utf-8');
      const parsed = JSON.parse(data);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].identifier.runId).toBe('123');
    });

    it('creates directory if it does not exist', async () => {
      const nestedDir = path.join(testDir, 'nested', 'dir');
      const nestedStore = new WatchStore(nestedDir);
      await nestedStore.saveAll([createTestWatch()]);

      const data = await fs.readFile(path.join(nestedDir, 'watches.json'), 'utf-8');
      expect(JSON.parse(data)).toHaveLength(1);
    });

    it('serializes concurrent writes', async () => {
      const watch1 = createTestWatch({ identifier: { ...createTestWatch().identifier, runId: '1' } });
      const watch2 = createTestWatch({ identifier: { ...createTestWatch().identifier, runId: '2' } });

      // Fire two saves concurrently — both should succeed without corruption
      await Promise.all([
        store.saveAll([watch1]),
        store.saveAll([watch1, watch2]),
      ]);

      const data = await fs.readFile(path.join(testDir, 'watches.json'), 'utf-8');
      const parsed = JSON.parse(data);
      // Second write should win (it was queued after the first)
      expect(parsed).toHaveLength(2);
    });
  });

  describe('round-trip', () => {
    it('saves and loads watches correctly', async () => {
      const watch = createTestWatch();
      await store.saveAll([watch]);

      const loaded = await store.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].identifier.runId).toBe('123');
      expect(loaded[0].status.overallState).toBe('running');
      expect(loaded[0].dismissed).toBe(false);
    });
  });
});
