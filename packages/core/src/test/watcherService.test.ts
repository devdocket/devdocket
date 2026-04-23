import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WatcherService, WatchedRun } from '../services/watcherService';
import { WatcherRegistry } from '../services/watcherRegistry';
import { PRWatcherRegistry } from '../services/prWatcherRegistry';
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
    loadAll: vi.fn().mockResolvedValue({ runs: [], prs: [] }),
    saveAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as WatchStore;
}

describe('WatcherService', () => {
  let service: WatcherService;
  let registry: WatcherRegistry;
  let prRegistry: PRWatcherRegistry;
  let logger: ReturnType<typeof createMockLogger>;
  let watchStore: WatchStore;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createMockLogger();
    registry = new WatcherRegistry(logger);
    prRegistry = new PRWatcherRegistry(logger);
    watchStore = createMockWatchStore();
    service = new WatcherService(registry, prRegistry, watchStore, logger);
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
      (watchStore.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue({ runs: [persistedWatch], prs: [] });
      
      await service.loadPersistedWatches();
      
      expect(service.getActiveWatches()).toHaveLength(1);
      expect(service.getActiveWatches()[0].identifier.runId).toBe('run-1');
    });
  });

  describe('PR watching', () => {
    function createMockPRWatcher(id: string = 'test-pr', snapshotFn?: () => Promise<import('@devdocket/shared').PRRunsSnapshot>): import('@devdocket/shared').DevDocketPRWatcher {
      return {
        id,
        label: `PR Watcher ${id}`,
        canWatch: vi.fn().mockReturnValue(true),
        parsePRUrl: vi.fn().mockReturnValue({
          providerId: id,
          prId: '42',
          displayName: 'PR #42',
          url: 'https://example.com/pr/42',
          repo: 'owner/repo',
        }),
        getPRRunsSnapshot: snapshotFn ? vi.fn(snapshotFn) : vi.fn().mockResolvedValue({
          prState: 'open',
          runs: [],
        }),
      };
    }

    function createPRIdentifier(providerId: string = 'test-pr'): import('@devdocket/shared').PRIdentifier {
      return {
        providerId,
        prId: '42',
        displayName: 'PR #42',
        url: 'https://example.com/pr/42',
        repo: 'owner/repo',
      };
    }

    it('starts a PR watch and fires change events', async () => {
      const prWatcher = createMockPRWatcher();
      prRegistry.register(prWatcher);
      const changeSpy = vi.fn();
      const prChangeSpy = vi.fn();
      service.onDidChangeWatchedRuns(changeSpy);
      service.onDidChangePRWatches(prChangeSpy);

      const result = await service.startPRWatch(createPRIdentifier());

      expect(result.identifier.prId).toBe('42');
      expect(result.prState).toBe('open');
      expect(result.dismissed).toBe(false);
      expect(prChangeSpy).toHaveBeenCalled();
      expect(changeSpy).toHaveBeenCalled();
    });

    it('throws if already watching the same PR', async () => {
      const prWatcher = createMockPRWatcher();
      prRegistry.register(prWatcher);

      await service.startPRWatch(createPRIdentifier());
      await expect(service.startPRWatch(createPRIdentifier())).rejects.toThrow('Already watching PR');
    });

    it('throws if no PR watcher registered for provider', async () => {
      await expect(service.startPRWatch(createPRIdentifier('unknown'))).rejects.toThrow('No PR watcher registered');
    });

    it('adds initial runs as child watches', async () => {
      const runWatcher = createMockWatcher('github-actions');
      registry.register(runWatcher);

      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [{
          providerId: 'github-actions',
          runId: 'run-1',
          displayName: 'CI Build',
          url: 'https://example.com/run/1',
          repo: 'owner/repo',
        }],
      }));
      prRegistry.register(prWatcher);

      const result = await service.startPRWatch(createPRIdentifier());

      expect(result.childRunKeys).toHaveLength(1);
      expect(service.getActiveWatches()).toHaveLength(1);
      expect(service.getActiveWatches()[0].parentPRKey).toBeDefined();
    });

    it('dismisses PR watch and its child runs', async () => {
      const runWatcher = createMockWatcher('github-actions');
      registry.register(runWatcher);

      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [{
          providerId: 'github-actions',
          runId: 'run-1',
          displayName: 'CI Build',
          url: 'https://example.com/run/1',
          repo: 'owner/repo',
        }],
      }));
      prRegistry.register(prWatcher);

      const identifier = createPRIdentifier();
      await service.startPRWatch(identifier);

      expect(service.getActiveWatches()).toHaveLength(1);
      expect(service.getActivePRWatches()).toHaveLength(1);

      service.dismissPRWatch(identifier);

      expect(service.getActiveWatches()).toHaveLength(0);
      expect(service.getActivePRWatches()).toHaveLength(0);
    });

    it('getActiveStandaloneWatches excludes child runs', async () => {
      const runWatcher = createMockWatcher('github-actions');
      registry.register(runWatcher);

      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [{
          providerId: 'github-actions',
          runId: 'run-1',
          displayName: 'CI Build',
          url: 'https://example.com/run/1',
          repo: 'owner/repo',
        }],
      }));
      prRegistry.register(prWatcher);

      await service.startPRWatch(createPRIdentifier());

      // Also start a standalone watch with the run watcher
      const standaloneIdentifier = { ...createIdentifier('github-actions'), runId: 'run-standalone' };
      await service.startWatch(standaloneIdentifier);

      expect(service.getActiveWatches()).toHaveLength(2);
      expect(service.getActiveStandaloneWatches()).toHaveLength(1);
      expect(service.getActiveStandaloneWatches()[0].identifier.runId).toBe('run-standalone');
    });

    it('dismissAllCompleted dismisses merged/closed PRs and their child runs', async () => {
      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'merged',
        runs: [],
      }));
      prRegistry.register(prWatcher);

      await service.startPRWatch(createPRIdentifier());

      expect(service.getActivePRWatches()).toHaveLength(1);
      expect(service.getActivePRWatches()[0].prState).toBe('merged');

      service.dismissAllCompleted();

      expect(service.getActivePRWatches()).toHaveLength(0);
    });

    it('polls PR watches and detects state transitions', async () => {
      let callCount = 0;
      const prWatcher = createMockPRWatcher('test-pr', async () => {
        callCount++;
        if (callCount === 1) {
          return { prState: 'open', runs: [] };
        }
        return { prState: 'merged', runs: [] };
      });
      prRegistry.register(prWatcher);

      await service.startPRWatch(createPRIdentifier());
      const completeSpy = vi.fn();
      service.onDidCompletePR(completeSpy);

      await vi.advanceTimersByTimeAsync(60000);

      expect(completeSpy).toHaveBeenCalledTimes(1);
      expect(service.getActivePRWatches()[0].prState).toBe('merged');
    });

    it('loads persisted PR watches', async () => {
      const prWatcher = createMockPRWatcher();
      prRegistry.register(prWatcher);

      const persistedPR = {
        identifier: createPRIdentifier(),
        prState: 'open' as const,
        childRunKeys: [],
        watchedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString(),
        dismissed: false,
      };
      (watchStore.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue({ runs: [], prs: [persistedPR] });

      await service.loadPersistedWatches();

      expect(service.getActivePRWatches()).toHaveLength(1);
      expect(service.getActivePRWatches()[0].identifier.prId).toBe('42');
    });

    it('resolves run identifiers via URL matching when providerId is unknown', async () => {
      // Register a run watcher that recognizes URLs
      const runWatcher = createMockWatcher('ado-pipelines');
      (runWatcher.canWatch as ReturnType<typeof vi.fn>).mockImplementation(
        (url: string) => url.includes('dev.azure.com') && url.includes('_build/results'),
      );
      (runWatcher.parseRunUrl as ReturnType<typeof vi.fn>).mockReturnValue({
        providerId: 'ado-pipelines',
        runId: '555',
        displayName: 'Build 555',
        url: 'https://dev.azure.com/org/project/_build/results?buildId=555',
        repo: 'org/project',
      });
      registry.register(runWatcher);

      // PR watcher returns a run with an unknown providerId but a recognizable URL
      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [{
          providerId: 'azure-pipelines',
          runId: '10',
          displayName: 'ADO Pipeline',
          url: 'https://dev.azure.com/org/project/_build/results?buildId=555',
          repo: 'owner/repo',
        }],
      }));
      prRegistry.register(prWatcher);

      const result = await service.startPRWatch(createPRIdentifier());

      expect(result.childRunKeys).toHaveLength(1);
      expect(service.getActiveWatches()).toHaveLength(1);
      // The resolved identifier should use the watcher's providerId
      expect(service.getActiveWatches()[0].identifier.providerId).toBe('ado-pipelines');
      expect(service.getActiveWatches()[0].identifier.runId).toBe('555');
    });

    it('skips run identifiers when no watcher matches providerId or URL', async () => {
      // No run watchers registered — unresolvable run
      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [{
          providerId: 'unknown-ci',
          runId: '99',
          displayName: 'Unknown CI',
          url: 'https://unknown-ci.example.com/build/99',
          repo: 'owner/repo',
        }],
      }));
      prRegistry.register(prWatcher);

      const result = await service.startPRWatch(createPRIdentifier());

      // Child run should not be added (no matching watcher)
      expect(result.childRunKeys).toHaveLength(0);
      expect(service.getActiveWatches()).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to add child run'));
    });
  });
});
