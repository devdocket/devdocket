import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WatcherService, WatchedRun } from '../services/watcherService';
import { WatcherRegistry } from '../services/watcherRegistry';
import { WatchStore } from '../storage/watchStore';
import type { DevDocketRunWatcher, RunIdentifier, RunStatus } from '@devdocket/shared';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockWatcher(id: string, statusFn?: () => Promise<RunStatus>): DevDocketRunWatcher {
  return {
    id,
    label: `Watcher ${id}`,
    canWatch: vi.fn().mockReturnValue(true),
    parseRunUrl: vi.fn().mockReturnValue({
      providerId: id,
      runId: 'run-1',
      displayName: 'Test Run',
      url: 'https://example.com/run/1',
    }),
    getRunStatus: statusFn ? vi.fn(statusFn) : vi.fn().mockResolvedValue({
      overallState: 'running',
      conclusion: undefined,
      jobs: [],
    }),
  };
}

function createIdentifier(providerId: string = 'test'): RunIdentifier {
  return {
    providerId,
    runId: 'run-1',
    displayName: 'Test Run',
    url: 'https://example.com/run/1',
  };
}

function createMockWatchStore(): WatchStore {
  return {
    loadAll: vi.fn().mockResolvedValue([]),
    saveAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as WatchStore;
}

describe('WatcherService', () => {
  let service: WatcherService;
  let registry: WatcherRegistry;
  let logger: ReturnType<typeof createMockLogger>;
  let watchStore: WatchStore;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createMockLogger();
    registry = new WatcherRegistry(logger);
    watchStore = createMockWatchStore();
    service = new WatcherService(registry, watchStore, logger);
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  describe('startWatch', () => {
    it('stores the watch and fires change event', async () => {
      const watcher = createMockWatcher('test');
      registry.register(watcher);
      const changeSpy = vi.fn();
      service.onDidChangeWatchedRuns(changeSpy);

      const identifier = createIdentifier();
      const result = await service.startWatch(identifier);

      expect(result.identifier).toBe(identifier);
      expect(result.status.overallState).toBe('running');
      expect(result.dismissed).toBe(false);
      expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    it('throws if already watching the same run', async () => {
      const watcher = createMockWatcher('test');
      registry.register(watcher);
      const identifier = createIdentifier();
      await service.startWatch(identifier);
      await expect(service.startWatch(identifier)).rejects.toThrow('Already watching');
    });

    it('throws if no watcher registered for provider', async () => {
      const identifier = createIdentifier('unknown');
      await expect(service.startWatch(identifier)).rejects.toThrow('No watcher registered');
    });
  });

  describe('dismissWatch', () => {
    it('marks the watch as dismissed and fires change event', async () => {
      const watcher = createMockWatcher('test');
      registry.register(watcher);
      const identifier = createIdentifier();
      await service.startWatch(identifier);

      const changeSpy = vi.fn();
      service.onDidChangeWatchedRuns(changeSpy);
      service.dismissWatch(identifier);

      expect(service.getActiveWatches()).toHaveLength(0);
      expect(changeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('dismissAllCompleted', () => {
    it('only dismisses completed watches', async () => {
      const completedWatcher = createMockWatcher('completed', async () => ({
        overallState: 'completed' as const,
        conclusion: 'success' as const,
        jobs: [],
      }));
      const runningWatcher = createMockWatcher('running');

      registry.register(completedWatcher);
      registry.register(runningWatcher);

      await service.startWatch(createIdentifier('completed'));
      await service.startWatch({ ...createIdentifier('running'), providerId: 'running', runId: 'run-2' });

      service.dismissAllCompleted();

      const active = service.getActiveWatches();
      expect(active).toHaveLength(1);
      expect(active[0].identifier.providerId).toBe('running');
    });
  });

  describe('polling', () => {
    it('polls active watches and detects job failures', async () => {
      let callCount = 0;
      const watcher = createMockWatcher('test', async () => {
        callCount++;
        if (callCount === 1) {
          return { overallState: 'running', conclusion: undefined, jobs: [] };
        }
        return {
          overallState: 'running' as const,
          conclusion: undefined,
          jobs: [{ name: 'build', state: 'completed' as const, conclusion: 'failure' as const }],
        };
      });
      registry.register(watcher);

      await service.startWatch(createIdentifier());

      const failureSpy = vi.fn();
      service.onDidDetectJobFailure(failureSpy);

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(60000);

      expect(failureSpy).toHaveBeenCalledTimes(1);
      expect(failureSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ name: 'build', conclusion: 'failure' }),
        }),
      );
    });

    it('fires onDidCompleteRun when run transitions to completed', async () => {
      let callCount = 0;
      const watcher = createMockWatcher('test', async () => {
        callCount++;
        if (callCount === 1) {
          return { overallState: 'running' as const, conclusion: undefined, jobs: [] };
        }
        return { overallState: 'completed' as const, conclusion: 'success' as const, jobs: [] };
      });
      registry.register(watcher);

      await service.startWatch(createIdentifier());

      const completeSpy = vi.fn();
      service.onDidCompleteRun(completeSpy);

      await vi.advanceTimersByTimeAsync(60000);

      expect(completeSpy).toHaveBeenCalledTimes(1);
    });

    it('sets hasWarning after 3 consecutive failures and skips run', async () => {
      let initialCall = true;
      const watcher = createMockWatcher('test');
      (watcher.getRunStatus as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (initialCall) {
          initialCall = false;
          return { overallState: 'running', conclusion: undefined, jobs: [] };
        }
        throw new Error('API down');
      });
      registry.register(watcher);

      await service.startWatch(createIdentifier());

      // 3 poll ticks to hit 3 failures
      await vi.advanceTimersByTimeAsync(60000);
      await vi.advanceTimersByTimeAsync(60000);
      await vi.advanceTimersByTimeAsync(60000);

      const watches = service.getActiveWatches();
      expect(watches[0].hasWarning).toBe(true);

      // After 3 failures, the run should be skipped on next poll
      const callCountBefore = (watcher.getRunStatus as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(60000);
      const callCountAfter = (watcher.getRunStatus as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callCountAfter).toBe(callCountBefore); // No new calls
    });

    it('stops polling when no active watches remain', async () => {
      const watcher = createMockWatcher('test');
      registry.register(watcher);

      await service.startWatch(createIdentifier());

      // Polling is now active — record call count after initial startWatch
      const callCountAfterStart = (watcher.getRunStatus as ReturnType<typeof vi.fn>).mock.calls.length;

      service.dismissWatch(createIdentifier());

      // Advance past several poll intervals — no new getRunStatus calls expected
      await vi.advanceTimersByTimeAsync(180000);
      const callCountAfterDismiss = (watcher.getRunStatus as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callCountAfterDismiss).toBe(callCountAfterStart);
    });
  });

  describe('persistence', () => {
    it('saves watches after startWatch', async () => {
      const watcher = createMockWatcher('test');
      registry.register(watcher);
      await service.startWatch(createIdentifier());
      // saveAll is called async — flush
      await vi.advanceTimersByTimeAsync(0);
      expect(watchStore.saveAll).toHaveBeenCalled();
    });

    it('loads persisted watches on loadPersistedWatches', async () => {
      const watcher = createMockWatcher('test');
      registry.register(watcher);
      
      const persistedWatch: WatchedRun = {
        identifier: createIdentifier(),
        status: { overallState: 'running', jobs: [] },
        watchedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString(),
        dismissed: false,
      };
      (watchStore.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue([persistedWatch]);
      
      await service.loadPersistedWatches();
      
      expect(service.getActiveWatches()).toHaveLength(1);
      expect(service.getActiveWatches()[0].identifier.runId).toBe('run-1');
    });
  });
});
