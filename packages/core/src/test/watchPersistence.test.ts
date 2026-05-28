import { describe, expect, it, vi } from 'vitest';
import { WatchPersistence } from '../services/watchPersistence';
import type { WatchedRun } from '../services/watcherService';
import type { WatchStore } from '../storage/watchStore';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockWatchStore(initialRuns: WatchedRun[] = []): WatchStore {
  return {
    loadAll: vi.fn().mockResolvedValue({ runs: initialRuns, prs: [] }),
    hasPRWatch: vi.fn().mockResolvedValue(false),
    saveAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as WatchStore;
}

function createRun(overrides: Partial<WatchedRun> = {}): WatchedRun {
  return {
    identifier: {
      providerId: 'test',
      runId: 'run-1',
      displayName: 'Test Run',
      url: 'https://example.com/run/1',
    },
    status: { overallState: 'running', jobs: [] },
    watchedAt: '2026-01-01T00:00:00.000Z',
    lastPolledAt: '2026-01-01T00:00:00.000Z',
    dismissed: false,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('WatchPersistence', () => {
  it('skips flushing when only lastPolledAt changed since load', async () => {
    const watchStore = createMockWatchStore([createRun()]);
    const persistence = new WatchPersistence(watchStore, createMockLogger());

    await persistence.loadAll(() => 'unused');
    (watchStore.saveAll as ReturnType<typeof vi.fn>).mockClear();

    await persistence.saveAll([
      createRun({ lastPolledAt: '2026-01-01T00:01:00.000Z' }),
    ], [], { immediate: true });

    expect(watchStore.saveAll).not.toHaveBeenCalled();
  });

  it('persists flushing when an actual field changes', async () => {
    const watchStore = createMockWatchStore([createRun()]);
    const persistence = new WatchPersistence(watchStore, createMockLogger());

    await persistence.loadAll(() => 'unused');
    (watchStore.saveAll as ReturnType<typeof vi.fn>).mockClear();

    await persistence.saveAll([
      createRun({
        status: {
          overallState: 'running',
          jobs: [{ name: 'build', state: 'completed', conclusion: 'success' }],
        },
        lastPolledAt: '2026-01-01T00:01:00.000Z',
      }),
    ], [], { immediate: true });

    expect(watchStore.saveAll).toHaveBeenCalledTimes(1);
    const [runs] = (watchStore.saveAll as ReturnType<typeof vi.fn>).mock.calls[0] as [WatchedRun[], unknown[]];
    expect(runs[0].status.jobs[0]).toEqual({ name: 'build', state: 'completed', conclusion: 'success' });
    expect(runs[0].lastPolledAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('keeps the canonical digest stable across lastPolledAt-only cycles', async () => {
    const watchStore = createMockWatchStore();
    const persistence = new WatchPersistence(watchStore, createMockLogger());

    await persistence.saveAll([createRun()], [], { immediate: true });
    await persistence.saveAll([
      createRun({ lastPolledAt: '2026-01-01T00:01:00.000Z' }),
    ], [], { immediate: true });
    await persistence.saveAll([
      createRun({ lastPolledAt: '2026-01-01T00:02:00.000Z' }),
    ], [], { immediate: true });

    expect(watchStore.saveAll).toHaveBeenCalledTimes(1);
  });

  it('queues a revert to the last persisted shape while another save is in flight', async () => {
    const initialRun = createRun();
    const watchStore = createMockWatchStore([initialRun]);
    const firstSave = createDeferred<void>();
    (watchStore.saveAll as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValue(undefined);
    const persistence = new WatchPersistence(watchStore, createMockLogger());

    await persistence.loadAll(() => 'unused');
    (watchStore.saveAll as ReturnType<typeof vi.fn>).mockClear();

    const changedFlush = persistence.saveAll([
      createRun({ status: { overallState: 'completed', conclusion: 'success', jobs: [] } }),
    ], [], { immediate: true }) as Promise<void>;

    await vi.waitFor(() => expect(watchStore.saveAll).toHaveBeenCalledTimes(1));

    const revertedFlush = persistence.saveAll([initialRun], [], { immediate: true }) as Promise<void>;

    firstSave.resolve();
    await vi.waitFor(() => expect(watchStore.saveAll).toHaveBeenCalledTimes(2));
    await Promise.all([changedFlush, revertedFlush]);

    const [revertedRuns] = (watchStore.saveAll as ReturnType<typeof vi.fn>).mock.calls[1] as [WatchedRun[], unknown[]];
    expect(revertedRuns[0].status).toEqual({ overallState: 'running', jobs: [] });
  });

  it('releases queued save tracking when persistence fails', async () => {
    const initialRun = createRun();
    const watchStore = createMockWatchStore([initialRun]);
    const persistence = new WatchPersistence(watchStore, createMockLogger());

    await persistence.loadAll(() => 'unused');
    (watchStore.saveAll as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);

    await persistence.saveAll([
      createRun({ status: { overallState: 'completed', conclusion: 'success', jobs: [] } }),
    ], [], { immediate: true });
    expect((persistence as any).queuedPersistCount).toBe(0);

    await persistence.saveAll([initialRun], [], { immediate: true });

    expect((persistence as any).queuedPersistCount).toBe(0);
    expect(watchStore.saveAll).toHaveBeenCalledTimes(1);
  });
});
