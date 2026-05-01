import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockMemento } from 'vscode';
import { WatchStore } from '../storage/watchStore';
import type { WatchedRun, WatchedPR } from '../services/watcherService';

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

function createTestPRWatch(overrides?: Partial<WatchedPR>): WatchedPR {
  return {
    identifier: {
      providerId: 'github-pr',
      prId: '42',
      displayName: 'PR #42',
      url: 'https://github.com/owner/repo/pull/42',
      repo: 'owner/repo',
    },
    prState: 'open',
    childRunKeys: [],
    watchedAt: '2026-01-01T00:00:00Z',
    lastPolledAt: '2026-01-01T00:00:00Z',
    dismissed: false,
    ...overrides,
  };
}

describe('WatchStore', () => {
  let memento: InstanceType<typeof MockMemento>;
  let store: WatchStore;

  beforeEach(() => {
    memento = new MockMemento();
    store = new WatchStore(memento);
  });

  describe('loadAll', () => {
    it('returns empty arrays when no data exists', async () => {
      const result = await store.loadAll();
      expect(result).toEqual({ runs: [], prs: [] });
    });

    it('loads valid watches from new envelope format', async () => {
      const watch = createTestWatch();
      const prWatch = createTestPRWatch();
      await memento.update('devdocket.watches', { runs: [watch], prs: [prWatch] });

      const result = await store.loadAll();
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].identifier.runId).toBe('123');
      expect(result.prs).toHaveLength(1);
      expect(result.prs[0].identifier.prId).toBe('42');
    });

    it('migrates legacy plain array format', async () => {
      const watch = createTestWatch();
      await memento.update('devdocket.watches', [watch]);

      const result = await store.loadAll();
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].identifier.runId).toBe('123');
      expect(result.prs).toEqual([]);
    });

    it('returns empty arrays for non-object/non-array data', async () => {
      await memento.update('devdocket.watches', 'just a string');

      const result = await store.loadAll();
      expect(result).toEqual({ runs: [], prs: [] });
    });

    it('filters out entries missing required fields', async () => {
      const valid = createTestWatch();
      const invalid = { foo: 'bar' };
      await memento.update('devdocket.watches', { runs: [valid, invalid], prs: [] });

      const result = await store.loadAll();
      expect(result.runs).toHaveLength(1);
    });
  });

  describe('hasPRWatch', () => {
    it('returns true for persisted dismissed PR watches', async () => {
      const prWatch = createTestPRWatch({ dismissed: true });
      await memento.update('devdocket.watches', { runs: [], prs: [prWatch] });

      await expect(store.hasPRWatch(prWatch.identifier)).resolves.toBe(true);
    });

    it('returns false when the PR watch is not persisted', async () => {
      await memento.update('devdocket.watches', { runs: [], prs: [] });

      await expect(store.hasPRWatch(createTestPRWatch().identifier)).resolves.toBe(false);
    });
  });

  describe('saveAll', () => {
    it('saves watches to globalState in envelope format', async () => {
      const watch = createTestWatch();
      const prWatch = createTestPRWatch();
      await store.saveAll([watch], [prWatch]);

      const persisted = memento.get<{ runs: WatchedRun[]; prs: WatchedPR[] }>('devdocket.watches');
      expect(persisted!.runs).toHaveLength(1);
      expect(persisted!.runs[0].identifier.runId).toBe('123');
      expect(persisted!.prs).toHaveLength(1);
      expect(persisted!.prs[0].identifier.prId).toBe('42');
    });
  });

  describe('round-trip', () => {
    it('saves and loads watches correctly', async () => {
      const watch = createTestWatch();
      const prWatch = createTestPRWatch();
      await store.saveAll([watch], [prWatch]);

      const loaded = await store.loadAll();
      expect(loaded.runs).toHaveLength(1);
      expect(loaded.runs[0].identifier.runId).toBe('123');
      expect(loaded.runs[0].status.overallState).toBe('running');
      expect(loaded.runs[0].dismissed).toBe(false);
      expect(loaded.prs).toHaveLength(1);
      expect(loaded.prs[0].identifier.prId).toBe('42');
      expect(loaded.prs[0].prState).toBe('open');
    });
  });
});
