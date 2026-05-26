import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WatcherService, WatchedRun } from '../services/watcherService';
import { WatcherRegistry } from '../services/watcherRegistry';
import { PRWatcherRegistry } from '../services/prWatcherRegistry';
import { WatchStore } from '../storage/watchStore';
import { PollingBackoffError, type DevDocketRunWatcher, type RunIdentifier, type RunStatus } from '@devdocket/shared';

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
  it('keeps host-specific run URL routing out of watcher services', () => {
    const serviceFiles = [
      '../services/watcherService.ts',
      '../services/prWatchPool.ts',
      '../services/runWatchPool.ts',
    ];
    const slash = String.fromCharCode(47);
    const backslash = String.fromCharCode(92);

    for (const serviceFile of serviceFiles) {
      const servicePath = fileURLToPath(new URL(serviceFile, import.meta.url));
      const serviceContents = readFileSync(servicePath, 'utf8');
      expect(serviceContents).not.toContain(['github', 'com'].join('.'));
      expect(serviceContents).not.toContain('isGitHubCheckRunUrl');
      expect(serviceContents).not.toContain(`${slash}runs${slash}`);
      expect(serviceContents).not.toContain(`${backslash}${slash}runs${backslash}${slash}`);
    }
  });

  let service: WatcherService;
  let registry: WatcherRegistry;
  let prRegistry: PRWatcherRegistry;
  let logger: ReturnType<typeof createMockLogger>;
  let watchStore: WatchStore;
  let mathRandomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    logger = createMockLogger();
    registry = new WatcherRegistry(logger);
    prRegistry = new PRWatcherRegistry(logger);
    watchStore = createMockWatchStore();
    service = new WatcherService(registry, prRegistry, watchStore, logger);
  });

  afterEach(() => {
    service.dispose();
    mathRandomSpy.mockRestore();
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

    it('does not acknowledge partial-success runs as failures', async () => {
      const watcher = createMockWatcher('test', async () => ({
        overallState: 'completed' as const,
        conclusion: 'partial_success' as const,
        jobs: [],
      }));
      registry.register(watcher);
      const watch = await service.startWatch(createIdentifier());

      service.acknowledgeAllFailures();

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

    it('backs off run polling until Retry-After expires', async () => {
      const { workspace } = await import('../test/__mocks__/vscode');
      workspace.getConfiguration.mockReturnValue({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (key === 'pollingIntervalSeconds') { return 15; }
          return defaultValue;
        }),
        update: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn(() => undefined),
      });

      let callCount = 0;
      const watcher = createMockWatcher('test');
      (watcher.getRunStatus as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          return { overallState: 'running' as const, conclusion: undefined, jobs: [] };
        }
        if (callCount === 2) {
          throw new PollingBackoffError({
            message: 'Rate limited',
            backoffKey: 'api.github.com',
            statusCode: 429,
            retryAfterMs: 60_000,
          });
        }
        return { overallState: 'running' as const, conclusion: undefined, jobs: [] };
      });
      registry.register(watcher);

      await service.startWatch({ ...createIdentifier(), backoffKey: 'api.github.com' });
      expect(watcher.getRunStatus).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(watcher.getRunStatus).toHaveBeenCalledTimes(2);
      expect(service.getActiveWatches()[0].hasWarning).not.toBe(true);

      await vi.advanceTimersByTimeAsync(45_000);
      expect(watcher.getRunStatus).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(watcher.getRunStatus).toHaveBeenCalledTimes(3);
      expect(service.getActiveWatches()[0].hasWarning).not.toBe(true);

      workspace.getConfiguration.mockReturnValue({
        get: vi.fn((_: string, defaultValue?: any) => defaultValue),
        update: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn(() => undefined),
      });
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
      await service.flushPersistence();
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

    it('flushPersistence waits for queued saves', async () => {
      const watcher = createMockWatcher('test');
      registry.register(watcher);

      let resolveSave: (() => void) | undefined;
      (watchStore.saveAll as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>(resolve => {
        resolveSave = resolve;
      }));

      await service.startWatch(createIdentifier());

      let flushed = false;
      const flushPromise = service.flushPersistence().then(() => {
        flushed = true;
      });
      await Promise.resolve();

      expect(flushed).toBe(false);
      resolveSave?.();
      await flushPromise;
      expect(flushed).toBe(true);
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

    it('backfills backoff keys for persisted run watches', async () => {
      const watcher = createMockWatcher('test');
      (watcher.parseRunUrl as ReturnType<typeof vi.fn>).mockReturnValue({
        providerId: 'test',
        runId: 'run-1',
        displayName: 'Test Run',
        url: 'https://example.com/run/1',
        backoffKey: 'api.example.com',
      });
      registry.register(watcher);

      const persistedWatch: WatchedRun = {
        identifier: createIdentifier(),
        status: { overallState: 'running', jobs: [] },
        watchedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString(),
        dismissed: false,
      };
      delete persistedWatch.identifier.backoffKey;
      (watchStore.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue({ runs: [persistedWatch], prs: [] });

      await service.loadPersistedWatches();

      expect(service.getActiveWatches()[0].identifier.backoffKey).toBe('api.example.com');
    });

    it('does not clobber a run watch started while persisted watches load', async () => {
      const identifier = { ...createIdentifier(), displayName: 'Live Run' };
      const persistedWatch: WatchedRun = {
        identifier: { ...identifier, displayName: 'Persisted Run' },
        status: { overallState: 'completed', conclusion: 'success', jobs: [] },
        watchedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString(),
        dismissed: false,
      };
      (watchStore.loadAll as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve({ runs: [persistedWatch], prs: [] }), 100);
      }));
      const watcher = createMockWatcher('test');
      registry.register(watcher);

      const loadPromise = service.loadPersistedWatches();
      await vi.advanceTimersByTimeAsync(50);

      const started = await service.startWatch(identifier);
      await vi.advanceTimersByTimeAsync(50);
      await loadPromise;

      const active = service.getActiveWatches();
      expect(active).toHaveLength(1);
      expect(active[0]).toBe(started);
      expect(active[0].identifier.displayName).toBe('Live Run');
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

    it('backfills backoff keys for persisted PR watches', async () => {
      const prWatcher = createMockPRWatcher();
      (prWatcher.parsePRUrl as ReturnType<typeof vi.fn>).mockReturnValue({
        providerId: 'test-pr',
        prId: '42',
        displayName: 'PR #42',
        url: 'https://example.com/pr/42',
        repo: 'owner/repo',
        backoffKey: 'api.example.com',
      });
      prRegistry.register(prWatcher);

      const persistedPR = {
        identifier: createPRIdentifier(),
        prState: 'open' as const,
        childRunKeys: [],
        watchedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString(),
        dismissed: false,
      };
      delete persistedPR.identifier.backoffKey;
      (watchStore.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue({ runs: [], prs: [persistedPR] });

      await service.loadPersistedWatches();

      expect(service.getAllPRWatches()[0].identifier.backoffKey).toBe('api.example.com');
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

    it('finds active PR watches by repo and PR id without matching provider id', async () => {
      const prWatcher = createMockPRWatcher('github-pr-watcher');
      prRegistry.register(prWatcher);
      const watch = await service.startPRWatch(createPRIdentifier('github-pr-watcher'));

      expect(service.findPRWatchByExternalId('owner/repo', '42')).toBe(watch);
      expect(service.findPRWatchByExternalId('owner/repo', '99')).toBeUndefined();

      service.dismissPRWatch(watch.identifier);
      expect(service.findPRWatchByExternalId('owner/repo', '42')).toBeUndefined();
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
      expect(runWatcher.getRunStatus).toHaveBeenCalledTimes(1);
    });

    it('can defer initial child run status fetches while still registering child runs', async () => {
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

      const result = await service.startPRWatch(createPRIdentifier(), { deferChildRunStatus: true });

      expect(result.childRunKeys).toHaveLength(1);
      expect(service.getActiveWatches()).toHaveLength(1);
      expect(service.getActiveWatches()[0].parentPRKey).toBe(service.getPRWatchKey(result.identifier));
      expect(runWatcher.getRunStatus).not.toHaveBeenCalled();
    });

    it('suppresses completion and failure events for the first deferred child run status fetch', async () => {
      const runWatcher: DevDocketRunWatcher = {
        id: 'github-actions',
        label: 'GitHub Actions',
        canWatch: vi.fn().mockReturnValue(true),
        parseRunUrl: vi.fn(),
        getRunStatus: vi.fn(async (identifier: RunIdentifier) => {
          if (identifier.runId === 'completed-run') {
            return { overallState: 'completed' as const, conclusion: 'success' as const, jobs: [] };
          }
          return {
            overallState: 'running' as const,
            conclusion: undefined,
            jobs: [{ name: 'build', state: 'completed' as const, conclusion: 'failure' as const }],
          };
        }),
      };
      registry.register(runWatcher);

      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [
          {
            providerId: 'github-actions',
            runId: 'completed-run',
            displayName: 'Completed Run',
            url: 'https://example.com/run/completed',
            repo: 'owner/repo',
          },
          {
            providerId: 'github-actions',
            runId: 'failing-run',
            displayName: 'Failing Run',
            url: 'https://example.com/run/failing',
            repo: 'owner/repo',
          },
        ],
      }));
      prRegistry.register(prWatcher);
      const completeSpy = vi.fn();
      const failureSpy = vi.fn();
      service.onDidCompleteRun(completeSpy);
      service.onDidDetectJobFailure(failureSpy);

      await service.startPRWatch(createPRIdentifier(), { deferChildRunStatus: true });
      expect(service.getActiveWatches().every(w => w.suppressNextStatusEvents)).toBe(true);

      await vi.advanceTimersByTimeAsync(60000);

      expect(completeSpy).not.toHaveBeenCalled();
      expect(failureSpy).not.toHaveBeenCalled();
      expect(service.getActiveWatches().every(w => w.suppressNextStatusEvents === undefined)).toBe(true);
      expect(service.getActiveWatches().map(w => w.status.overallState).sort()).toEqual(['completed', 'running']);

      (runWatcher.getRunStatus as ReturnType<typeof vi.fn>).mockImplementation(async (identifier: RunIdentifier) => {
        if (identifier.runId === 'completed-run') {
          return { overallState: 'completed' as const, conclusion: 'success' as const, jobs: [] };
        }
        return {
          overallState: 'running' as const,
          conclusion: undefined,
          jobs: [
            { name: 'build', state: 'completed' as const, conclusion: 'failure' as const },
            { name: 'test', state: 'completed' as const, conclusion: 'failure' as const },
          ],
        };
      });

      await vi.advanceTimersByTimeAsync(60000);

      expect(failureSpy).toHaveBeenCalledTimes(1);
      expect(failureSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ name: 'test', conclusion: 'failure' }),
        }),
      );
    });

    it('clears failure acknowledgement when deferred child registration replaces a dismissed run', async () => {
      const runWatcher = createMockWatcher('github-actions');
      registry.register(runWatcher);

      const runIdentifier = {
        providerId: 'github-actions',
        runId: 'run-1',
        displayName: 'CI Build',
        url: 'https://example.com/run/1',
        repo: 'owner/repo',
      };
      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [runIdentifier],
      }));
      prRegistry.register(prWatcher);

      const runPool = (service as any).runPool;
      const runKey = runPool.getWatchKey(runIdentifier);
      runPool.watches.set(runKey, {
        identifier: runIdentifier,
        status: { overallState: 'completed', conclusion: 'failure', jobs: [] },
        watchedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString(),
        dismissed: true,
        parentPRKey: service.getPRWatchKey(createPRIdentifier()),
      });
      runPool.acknowledgedFailedRunKeys.add(runKey);

      await service.startPRWatch(createPRIdentifier(), { deferChildRunStatus: true });

      const [rewatchedRun] = service.getActiveWatches();
      expect(rewatchedRun).toBeDefined();
      expect(service.isFailureAcknowledged(rewatchedRun)).toBe(false);
    });

    it('adds child runs when the provider-owned watcher is registered without warn logs', async () => {
      const runWatcher = createMockWatcher('security-scanner');
      registry.register(runWatcher);

      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [{
          providerId: 'security-scanner',
          runId: '12345',
          displayName: 'Security Scan',
          url: 'https://scanner.example.com/results/12345',
          repo: 'owner/repo',
        }],
      }));
      prRegistry.register(prWatcher);

      const result = await service.startPRWatch(createPRIdentifier());
      const activeWatches = service.getActiveWatches();

      expect(result.childRunKeys).toHaveLength(1);
      expect(activeWatches).toHaveLength(1);
      expect(activeWatches[0].identifier.providerId).toBe('security-scanner');
      expect(activeWatches[0].identifier.runId).toBe('12345');
      expect(activeWatches[0].identifier.displayName).toBe('Security Scan');
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('Failed to add child run'));
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

    it('does not clobber a PR watch started while persisted watches load', async () => {
      const identifier = createPRIdentifier();
      const persistedPR = {
        identifier: { ...identifier, displayName: 'Persisted PR #42' },
        prState: 'closed' as const,
        childRunKeys: [],
        watchedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString(),
        dismissed: false,
      };
      const otherPersistedPR = {
        identifier: { ...createPRIdentifier(), prId: '99', displayName: 'Persisted PR #99' },
        prState: 'open' as const,
        childRunKeys: [],
        watchedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString(),
        dismissed: false,
      };
      (watchStore.loadAll as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve({ runs: [], prs: [persistedPR, otherPersistedPR] }), 100);
      }));
      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        displayName: 'Live PR #42',
        runs: [],
      }));
      prRegistry.register(prWatcher);

      const loadPromise = service.loadPersistedWatches();
      await vi.advanceTimersByTimeAsync(50);

      const started = await service.startPRWatch(identifier);
      expect(started.identifier.displayName).toBe('Live PR #42');

      await vi.advanceTimersByTimeAsync(50);
      await loadPromise;

      const active = service.getActivePRWatches();
      expect(active).toHaveLength(2);
      expect(active.find(pr => pr.identifier.prId === '42')).toBe(started);
      expect(active.find(pr => pr.identifier.prId === '42')?.identifier.displayName).toBe('Live PR #42');
      expect(active.find(pr => pr.identifier.prId === '42')?.prState).toBe('open');
      expect(active.find(pr => pr.identifier.prId === '99')?.identifier.displayName).toBe('Persisted PR #99');
      expect(watchStore.saveAll).toHaveBeenLastCalledWith(
        [],
        expect.arrayContaining([
          expect.objectContaining({ identifier: expect.objectContaining({ prId: '42', displayName: 'Live PR #42' }) }),
          expect.objectContaining({ identifier: expect.objectContaining({ prId: '99', displayName: 'Persisted PR #99' }) }),
        ]),
      );
    });

    it('trusts non-empty child run providerIds without URL matching', async () => {
      const runWatcher = createMockWatcher('url-matched-provider');
      (runWatcher.canWatch as ReturnType<typeof vi.fn>).mockReturnValue(true);
      registry.register(runWatcher);
      const findWatcherForUrlSpy = vi.spyOn(registry, 'findWatcherForUrl');

      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [{
          providerId: 'authoritative-provider',
          runId: '99',
          displayName: 'Provider-owned Check',
          url: 'https://ci.example.com/checks/99',
          repo: 'owner/repo',
        }],
      }));
      prRegistry.register(prWatcher);

      const result = await service.startPRWatch(createPRIdentifier());

      expect(result.childRunKeys).toHaveLength(0);
      expect(service.getActiveWatches()).toHaveLength(0);
      expect(findWatcherForUrlSpy).not.toHaveBeenCalled();
      expect(runWatcher.canWatch).not.toHaveBeenCalled();
      expect(runWatcher.parseRunUrl).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('No watcher registered for provider: authoritative-provider'));
    });

    it('resolves run identifiers via URL matching when providerId is empty', async () => {
      const runWatcher = createMockWatcher('url-matched-provider');
      (runWatcher.canWatch as ReturnType<typeof vi.fn>).mockImplementation(
        (url: string) => url.startsWith('https://ci.example.com/builds/'),
      );
      (runWatcher.parseRunUrl as ReturnType<typeof vi.fn>).mockReturnValue({
        providerId: 'url-matched-provider',
        runId: '555',
        displayName: 'Build 555',
        url: 'https://ci.example.com/builds/555',
        repo: 'org/project',
      });
      registry.register(runWatcher);
      const findWatcherForUrlSpy = vi.spyOn(registry, 'findWatcherForUrl');

      const prWatcher = createMockPRWatcher('test-pr', async () => ({
        prState: 'open',
        runs: [{
          providerId: '',
          runId: '10',
          displayName: 'Raw URL Build',
          url: 'https://ci.example.com/builds/555',
          repo: 'owner/repo',
        }],
      }));
      prRegistry.register(prWatcher);

      const result = await service.startPRWatch(createPRIdentifier());

      expect(result.childRunKeys).toHaveLength(1);
      expect(service.getActiveWatches()).toHaveLength(1);
      expect(findWatcherForUrlSpy).toHaveBeenCalledWith('https://ci.example.com/builds/555');
      expect(runWatcher.parseRunUrl).toHaveBeenCalledWith('https://ci.example.com/builds/555');
      expect(service.getActiveWatches()[0].identifier.providerId).toBe('url-matched-provider');
      expect(service.getActiveWatches()[0].identifier.runId).toBe('555');
    });

    it('skips run identifiers when no watcher matches providerId', async () => {
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
