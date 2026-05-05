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
    hasPRWatch: vi.fn().mockResolvedValue(false),
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

    it('is idempotent when already watching the same run (returns existing)', async () => {
      const watcher = createMockWatcher('test');
      registry.register(watcher);
      const identifier = createIdentifier();
      const first = await service.startWatch(identifier);
      const second = await service.startWatch(identifier);
      expect(second).toBe(first);
      // The active-state helper should also report true throughout.
      expect(service.isRunActive(identifier)).toBe(true);
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

  describe('failure acknowledgement', () => {
    it('clears the acknowledgement when a watch is dismissed', async () => {
      const watcher = createMockWatcher('test', async () => ({
        overallState: 'completed' as const,
        conclusion: 'failure' as const,
        jobs: [],
      }));
      registry.register(watcher);
      const identifier = createIdentifier();
      const watch = await service.startWatch(identifier);

      service.acknowledgeAllFailures();
      expect(service.isFailureAcknowledged(watch)).toBe(true);

      service.dismissWatch(identifier);
      expect(service.isFailureAcknowledged(watch)).toBe(false);
    });

    it('clears the acknowledgement when a dismissed watch is re-watched', async () => {
      const watcher = createMockWatcher('test', async () => ({
        overallState: 'completed' as const,
        conclusion: 'failure' as const,
        jobs: [],
      }));
      registry.register(watcher);
      const identifier = createIdentifier();
      await service.startWatch(identifier);

      service.acknowledgeAllFailures();
      service.dismissWatch(identifier);
      // dismissWatch already clears the ack; re-watching should also start fresh.
      const second = await service.startWatch(identifier);
      expect(service.isFailureAcknowledged(second)).toBe(false);
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

    it('clears acknowledgement keys when dismissing completed runs', async () => {
      // Regression test for the previously-missed branch: dismissAllCompleted
      // dismissed runs but never cleared their ack keys, so a re-watch of
      // the same identifier would be permanently silenced.
      const watcher = createMockWatcher('test', async () => ({
        overallState: 'completed' as const,
        conclusion: 'failure' as const,
        jobs: [],
      }));
      registry.register(watcher);
      const identifier = createIdentifier();
      const watch = await service.startWatch(identifier);

      service.acknowledgeAllFailures();
      expect(service.isFailureAcknowledged(watch)).toBe(true);

      service.dismissAllCompleted();
      // The watch is now dismissed; the ack key should be gone too so a
      // re-watch can alert on its first failure.
      expect(service.isFailureAcknowledged(watch)).toBe(false);

      const second = await service.startWatch(identifier);
      expect(service.isFailureAcknowledged(second)).toBe(false);
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

    it('does not persist after dispose() while a poll is in flight', async () => {
      // Regression: dispose() clears this.watches synchronously, but a
      // poll that was awaiting an HTTP call would resume after the clear,
      // see the empty maps, and call persistWatches() with empty arrays —
      // wiping the user's persisted watch list on next launch.
      const pendingResolvers: ((value: any) => void)[] = [];
      let callCount = 0;
      const watcher = createMockWatcher('test');
      (watcher.getRunStatus as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount += 1;
        // First call (from startWatch) resolves immediately so the test
        // can set up a watch. Subsequent calls (from polling) stall until
        // the test resolves them explicitly.
        if (callCount === 1) {
          return Promise.resolve({ overallState: 'running', conclusion: undefined, jobs: [] });
        }
        return new Promise<any>(resolve => { pendingResolvers.push(resolve); });
      });
      registry.register(watcher);
      await service.startWatch(createIdentifier());
      // Reset the saveAll spy to ignore the post-startWatch persist.
      (watchStore.saveAll as ReturnType<typeof vi.fn>).mockClear();
      // Advance timers to start the poll. Don't await — the poll's await
      // is now stalled on the second getRunStatus call.
      void vi.advanceTimersByTimeAsync(60000);
      // Wait for the poll to enter its await state.
      await vi.waitFor(() => expect(pendingResolvers).toHaveLength(1));
      // Dispose mid-flight, then resolve the in-flight poll.
      service.dispose();
      pendingResolvers[0]({ overallState: 'completed', conclusion: 'success', jobs: [] });
      // Flush microtasks so the .then() chain runs.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(watchStore.saveAll).not.toHaveBeenCalled();
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

    it('reports watched PRs even after they are dismissed', async () => {
      const prWatcher = createMockPRWatcher();
      prRegistry.register(prWatcher);
      const identifier = createPRIdentifier();

      await expect(service.isPRWatched(identifier)).resolves.toBe(false);

      await service.startPRWatch(identifier);
      await expect(service.isPRWatched(identifier)).resolves.toBe(true);

      service.dismissPRWatch(identifier);
      await expect(service.isPRWatched(identifier)).resolves.toBe(true);
    });

    it('reports dismissed PR watches persisted from a previous session', async () => {
      const identifier = createPRIdentifier();
      (watchStore.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        runs: [],
        prs: [{
          identifier,
          prState: 'closed',
          childRunKeys: [],
          watchedAt: new Date().toISOString(),
          lastPolledAt: new Date().toISOString(),
          dismissed: true,
        }],
      });

      await expect(service.isPRWatched(identifier)).resolves.toBe(true);
      expect(watchStore.loadAll).toHaveBeenCalledTimes(1);
    });

    it('caches persisted PR watch lookups across repeated checks', async () => {
      const identifier = createPRIdentifier();
      (watchStore.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        runs: [],
        prs: [{
          identifier,
          prState: 'closed',
          childRunKeys: [],
          watchedAt: new Date().toISOString(),
          lastPolledAt: new Date().toISOString(),
          dismissed: true,
        }],
      });

      await expect(service.isPRWatched(identifier)).resolves.toBe(true);
      await expect(service.isPRWatched(identifier)).resolves.toBe(true);

      expect(watchStore.loadAll).toHaveBeenCalledTimes(1);
    });

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

    it('is idempotent when already watching the same PR (returns existing)', async () => {
      const prWatcher = createMockPRWatcher();
      prRegistry.register(prWatcher);

      const first = await service.startPRWatch(createPRIdentifier());
      const second = await service.startPRWatch(createPRIdentifier());
      expect(second).toBe(first);
      expect(service.isPRActive(createPRIdentifier())).toBe(true);
    });

    it('re-creates child runs when called with forceRecreate for a dismissed childless PR', async () => {
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

      const childRun = service.getActiveWatches()[0];
      service.dismissWatch(childRun.identifier);
      expect(service.getActiveWatches()).toHaveLength(0);
      expect(service.isPRActive(identifier)).toBe(false);
      expect(service.getChildRuns(service.getPRWatchKey(identifier))).toHaveLength(0);

      // Manual "Watch URL" with forceRecreate — wipes and rebuilds.
      await service.startPRWatch(identifier, { forceRecreate: true });
      expect(service.getActiveWatches()).toHaveLength(1);
      expect(service.getChildRuns(service.getPRWatchKey(identifier))).toHaveLength(1);
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

    it('dismisses a PR watch when its last visible child run is dismissed', async () => {
      const runWatcher = createMockWatcher('github-actions');
      registry.register(runWatcher);

      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [
          {
            providerId: 'github-actions',
            runId: 'run-1',
            displayName: 'CI Build 1',
            url: 'https://example.com/run/1',
            repo: 'owner/repo',
          },
          {
            providerId: 'github-actions',
            runId: 'run-2',
            displayName: 'CI Build 2',
            url: 'https://example.com/run/2',
            repo: 'owner/repo',
          },
        ],
      }));
      prRegistry.register(prWatcher);

      const identifier = createPRIdentifier();
      await service.startPRWatch(identifier);
      const [firstChild, secondChild] = service.getActiveWatches();
      const prChangeSpy = vi.fn();
      service.onDidChangePRWatches(prChangeSpy);

      service.dismissWatch(firstChild.identifier);
      expect(prChangeSpy).not.toHaveBeenCalled();
      expect(service.isPRActive(identifier)).toBe(true);
      expect(service.getChildRuns(service.getPRWatchKey(identifier))).toHaveLength(1);

      service.dismissWatch(secondChild.identifier);
      expect(prChangeSpy).toHaveBeenCalledTimes(1);
      expect(service.isPRActive(identifier)).toBe(false);
      expect(service.getChildRuns(service.getPRWatchKey(identifier))).toHaveLength(0);
    });

    it('dismissAllCompleted cascades to an open PR when all visible child runs are dismissed', async () => {
      const runWatcher = createMockWatcher('github-actions', async () => ({
        overallState: 'completed' as const,
        conclusion: 'success' as const,
        jobs: [],
      }));
      registry.register(runWatcher);

      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [
          {
            providerId: 'github-actions',
            runId: 'run-1',
            displayName: 'CI Build 1',
            url: 'https://example.com/run/1',
            repo: 'owner/repo',
          },
          {
            providerId: 'github-actions',
            runId: 'run-2',
            displayName: 'CI Build 2',
            url: 'https://example.com/run/2',
            repo: 'owner/repo',
          },
        ],
      }));
      prRegistry.register(prWatcher);

      const identifier = createPRIdentifier();
      await service.startPRWatch(identifier);

      expect(service.countCompletedActiveWatches()).toBe(3);
      expect(service.dismissAllCompleted()).toBe(3);
      expect(service.getActiveWatches()).toHaveLength(0);
      expect(service.isPRActive(identifier)).toBe(false);
    });

    it('does not dismiss a PR watch that has never observed a child run', async () => {
      const completedWatcher = createMockWatcher('completed', async () => ({
        overallState: 'completed' as const,
        conclusion: 'success' as const,
        jobs: [],
      }));
      registry.register(completedWatcher);

      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [],
      }));
      prRegistry.register(prWatcher);

      const identifier = createPRIdentifier();
      await service.startPRWatch(identifier);
      await service.startWatch(createIdentifier('completed'));

      expect(service.dismissAllCompleted()).toBe(1);
      expect(service.isPRActive(identifier)).toBe(true);
    });

    it('dismisses a PR watch when polling removes its last observed child run', async () => {
      const runWatcher = createMockWatcher('github-actions');
      registry.register(runWatcher);

      let callCount = 0;
      const prWatcher = createMockPRWatcher('test-pr', async () => {
        callCount++;
        if (callCount === 1) {
          return {
            prState: 'open',
            runs: [{
              providerId: 'github-actions',
              runId: 'run-1',
              displayName: 'CI Build',
              url: 'https://example.com/run/1',
              repo: 'owner/repo',
            }],
          };
        }
        return { prState: 'open', runs: [] };
      });
      prRegistry.register(prWatcher);

      const identifier = createPRIdentifier();
      await service.startPRWatch(identifier);
      expect(service.getActiveWatches()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60000);

      expect(service.getActiveWatches()).toHaveLength(0);
      expect(service.isPRActive(identifier)).toBe(false);
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
        (url: string) => {
          try {
            const u = new URL(url);
            return u.hostname === 'dev.azure.com' && u.pathname.includes('_build/results');
          } catch { return false; }
        },
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

  describe('configuration change handling', () => {
    it('restarts polling with new interval when config changes while polling is active', async () => {
      const watcher = createMockWatcher('test');
      registry.register(watcher);

      const identifier = createIdentifier();
      await service.startWatch(identifier);
      // startWatch calls getRunStatus once for initial fetch
      expect(watcher.getRunStatus).toHaveBeenCalledTimes(1);

      // Advance to trigger one poll tick
      await vi.advanceTimersByTimeAsync(60000);
      expect(watcher.getRunStatus).toHaveBeenCalledTimes(2);

      // Change the config to a 30s interval
      const { workspace } = await import('../test/__mocks__/vscode');
      workspace.getConfiguration.mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'pollingIntervalSeconds') { return 30; }
          return defaultValue;
        }),
        update: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn(() => undefined),
      });

      // Fire configuration change event
      workspace._onDidChangeConfigurationEmitter.fire({
        affectsConfiguration: (section: string) => section === 'devDocket.watches.pollingIntervalSeconds',
      });

      // Reset call count to measure new interval
      (watcher.getRunStatus as ReturnType<typeof vi.fn>).mockClear();

      // Advance 30s — should trigger poll with new interval
      await vi.advanceTimersByTimeAsync(30000);
      expect(watcher.getRunStatus).toHaveBeenCalledTimes(1);
    });

    it('does nothing when config changes but polling is not active', async () => {
      // No watches added, so polling is not active
      const { workspace } = await import('../test/__mocks__/vscode');

      // Fire configuration change — should not throw or start polling
      workspace._onDidChangeConfigurationEmitter.fire({
        affectsConfiguration: (section: string) => section === 'devDocket.watches.pollingIntervalSeconds',
      });

      // Advance time — no polling should have started
      await vi.advanceTimersByTimeAsync(60000);
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Started polling'));
    });

    it('disposes config subscription when service is disposed', async () => {
      const { workspace } = await import('../test/__mocks__/vscode');

      // Verify the config listener is registered
      const emitter = workspace._onDidChangeConfigurationEmitter;
      const listenersBefore = (emitter as any).listeners.length;
      expect(listenersBefore).toBeGreaterThan(0);

      // Dispose the service — should remove the config listener
      service.dispose();

      const listenersAfter = (emitter as any).listeners.length;
      expect(listenersAfter).toBe(listenersBefore - 1);
    });
  });
});
