import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { logger } from '../services/logger';
import { JsonFileStore } from '../storage/fileStore';
import { WatchStore } from '../storage/watchStore';
import type { WatchedPR, WatchedRun } from '../services/watcherService';
import { type MockFileSystem, useMockFileSystem } from './testFileSystem';

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

function isoOffset(baseMs: number, offset: number): string {
  return new Date(baseMs + offset * 1000).toISOString();
}

function createCompletedRun(index: number, watchedAt = isoOffset(Date.UTC(2026, 0, 1), index)): WatchedRun {
  return createTestWatch({
    identifier: {
      providerId: 'github-actions',
      runId: String(index),
      displayName: `Run ${index}`,
      url: `https://github.com/owner/repo/actions/runs/${index}`,
      repo: 'owner/repo',
    },
    status: { overallState: 'completed', conclusion: 'success', jobs: [] },
    watchedAt,
    lastPolledAt: watchedAt,
  });
}

function createActiveRun(index: number, watchedAt = isoOffset(Date.UTC(2026, 1, 1), index)): WatchedRun {
  return createTestWatch({
    identifier: {
      providerId: 'github-actions',
      runId: String(index),
      displayName: `Run ${index}`,
      url: `https://github.com/owner/repo/actions/runs/${index}`,
      repo: 'owner/repo',
    },
    status: { overallState: 'running', jobs: [] },
    watchedAt,
    lastPolledAt: watchedAt,
  });
}

function createClosedPR(index: number, watchedAt = isoOffset(Date.UTC(2026, 0, 1), index)): WatchedPR {
  return createTestPRWatch({
    identifier: {
      providerId: 'github-pr',
      prId: String(index),
      displayName: `PR #${index}`,
      url: `https://github.com/owner/repo/pull/${index}`,
      repo: 'owner/repo',
    },
    prState: 'closed',
    watchedAt,
    lastPolledAt: watchedAt,
  });
}

function createOpenPR(index: number, watchedAt = isoOffset(Date.UTC(2026, 1, 1), index)): WatchedPR {
  return createTestPRWatch({
    identifier: {
      providerId: 'github-pr',
      prId: String(index),
      displayName: `PR #${index}`,
      url: `https://github.com/owner/repo/pull/${index}`,
      repo: 'owner/repo',
    },
    prState: 'open',
    watchedAt,
    lastPolledAt: watchedAt,
  });
}

describe('WatchStore', () => {
  const fileUri = vscode.Uri.file('C:\\test\\watches.json');
  let fileSystem: MockFileSystem;
  let store: WatchStore;

  beforeEach(() => {
    vi.clearAllMocks();
    fileSystem = useMockFileSystem();
    store = new WatchStore(new JsonFileStore(fileUri, 'watches.json'));
  });

  describe('loadAll', () => {
    it('returns empty arrays when no data exists', async () => {
      const result = await store.loadAll();
      expect(result).toEqual({ runs: [], prs: [] });
    });

    it('loads valid watches from new envelope format', async () => {
      const watch = createTestWatch();
      const prWatch = createTestPRWatch();
      fileSystem.writeJson(fileUri, { runs: [watch], prs: [prWatch] });

      const result = await store.loadAll();
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].identifier.runId).toBe('123');
      expect(result.prs).toHaveLength(1);
      expect(result.prs[0].identifier.prId).toBe('42');
    });

    it('migrates legacy plain array format', async () => {
      const watch = createTestWatch();
      fileSystem.writeJson(fileUri, [watch]);

      const result = await store.loadAll();
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].identifier.runId).toBe('123');
      expect(result.prs).toEqual([]);
    });

    it('returns empty arrays for non-object/non-array data', async () => {
      fileSystem.writeJson(fileUri, 'just a string');

      const result = await store.loadAll();
      expect(result).toEqual({ runs: [], prs: [] });
    });

    it('filters out entries missing required fields', async () => {
      const valid = createTestWatch();
      const invalid = { foo: 'bar' };
      fileSystem.writeJson(fileUri, { runs: [valid, invalid], prs: [] });

      const result = await store.loadAll();
      expect(result.runs).toHaveLength(1);
    });

    it('treats legacy entries without watchedAt as the oldest and evicts them first', async () => {
      const legacyRun = {
        ...createCompletedRun(-1),
        watchedAt: undefined,
      } as unknown as WatchedRun;
      const legacyPR = {
        ...createClosedPR(-1),
        watchedAt: undefined,
      } as unknown as WatchedPR;
      const runs = [legacyRun, ...Array.from({ length: 1_000 }, (_, i) => createCompletedRun(i, isoOffset(Date.UTC(2026, 0, 2), i)))];
      const prs = [legacyPR, ...Array.from({ length: 1_000 }, (_, i) => createClosedPR(i, isoOffset(Date.UTC(2026, 0, 3), i)))];
      fileSystem.writeJson(fileUri, { runs, prs });

      const loaded = await store.loadAll();

      expect(loaded.runs).toHaveLength(1_000);
      expect(loaded.prs).toHaveLength(1_000);
      expect(loaded.runs.some(run => run.identifier.runId === '-1')).toBe(false);
      expect(loaded.prs.some(pr => pr.identifier.prId === '-1')).toBe(false);
    });

    it('trims oversized persisted watches on load and logs once', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      fileSystem.writeJson(fileUri, {
        runs: Array.from({ length: 1_001 }, (_, i) => createCompletedRun(i, isoOffset(Date.UTC(2026, 0, 4), i))),
        prs: Array.from({ length: 1_001 }, (_, i) => createClosedPR(i, isoOffset(Date.UTC(2026, 0, 5), i))),
      });

      const loaded = await store.loadAll();
      const persisted = fileSystem.readJson<{ runs: WatchedRun[]; prs: WatchedPR[] }>(fileUri)!;

      expect(loaded.runs).toHaveLength(1_000);
      expect(loaded.prs).toHaveLength(1_000);
      expect(persisted.runs).toHaveLength(1_000);
      expect(persisted.prs).toHaveLength(1_000);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Trimmed watches.json while loading to enforce caps'));
    });
  });

  describe('hasPRWatch', () => {
    it('returns true for persisted dismissed PR watches', async () => {
      const prWatch = createTestPRWatch({ dismissed: true });
      fileSystem.writeJson(fileUri, { runs: [], prs: [prWatch] });

      await expect(store.hasPRWatch(prWatch.identifier)).resolves.toBe(true);
    });

    it('returns false when the PR watch is not persisted', async () => {
      fileSystem.writeJson(fileUri, { runs: [], prs: [] });

      await expect(store.hasPRWatch(createTestPRWatch().identifier)).resolves.toBe(false);
    });
  });

  describe('saveAll', () => {
    it('saves watches in envelope format', async () => {
      const watch = createTestWatch();
      const prWatch = createTestPRWatch();
      await store.saveAll([watch], [prWatch]);

      const persisted = fileSystem.readJson<{ runs: WatchedRun[]; prs: WatchedPR[] }>(fileUri);
      expect(persisted!.runs).toHaveLength(1);
      expect(persisted!.runs[0].identifier.runId).toBe('123');
      expect(persisted!.prs).toHaveLength(1);
      expect(persisted!.prs[0].identifier.prId).toBe('42');
    });

    it('does not evict active runs or PRs when the total exceeds the cap', async () => {
      const runs = [
        ...Array.from({ length: 1_000 }, (_, i) => createActiveRun(i, isoOffset(Date.UTC(2026, 1, 2), i))),
        createCompletedRun(10_001, '2026-01-01T00:00:00Z'),
        createCompletedRun(10_002, '2026-01-01T00:00:01Z'),
      ];
      const prs = [
        ...Array.from({ length: 1_000 }, (_, i) => createOpenPR(i, isoOffset(Date.UTC(2026, 1, 3), i))),
        createClosedPR(10_001, '2026-01-01T00:00:00Z'),
        createClosedPR(10_002, '2026-01-01T00:00:01Z'),
      ];

      await store.saveAll(runs, prs);
      const persisted = fileSystem.readJson<{ runs: WatchedRun[]; prs: WatchedPR[] }>(fileUri)!;

      expect(persisted.runs).toHaveLength(1_000);
      expect(persisted.prs).toHaveLength(1_000);
      expect(persisted.runs.every(run => run.status.overallState !== 'completed')).toBe(true);
      expect(persisted.prs.every(pr => pr.prState === 'open')).toBe(true);
    });

    it('evicts terminal runs and PRs oldest-first', async () => {
      await store.saveAll(
        Array.from({ length: 1_002 }, (_, i) => createCompletedRun(i, isoOffset(Date.UTC(2026, 0, 6), i))),
        Array.from({ length: 1_002 }, (_, i) => createClosedPR(i, isoOffset(Date.UTC(2026, 0, 7), i))),
      );

      const persisted = fileSystem.readJson<{ runs: WatchedRun[]; prs: WatchedPR[] }>(fileUri)!;

      expect(persisted.runs).toHaveLength(1_000);
      expect(persisted.prs).toHaveLength(1_000);
      expect(persisted.runs.some(run => run.identifier.runId === '0')).toBe(false);
      expect(persisted.runs.some(run => run.identifier.runId === '1')).toBe(false);
      expect(persisted.runs.some(run => run.identifier.runId === '2')).toBe(true);
      expect(persisted.prs.some(pr => pr.identifier.prId === '0')).toBe(false);
      expect(persisted.prs.some(pr => pr.identifier.prId === '1')).toBe(false);
      expect(persisted.prs.some(pr => pr.identifier.prId === '2')).toBe(true);
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
