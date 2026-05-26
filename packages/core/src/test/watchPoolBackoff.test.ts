import { describe, expect, it, vi } from 'vitest';
import { PollingBackoffError, type DevDocketPRWatcher, type DevDocketRunWatcher, type PRIdentifier, type RunIdentifier } from '@devdocket/shared';
import { WatcherRegistry } from '../services/watcherRegistry';
import { PRWatcherRegistry } from '../services/prWatcherRegistry';
import { PollingBackoffRegistry } from '../services/pollingBackoffRegistry';
import { PRWatchPool } from '../services/prWatchPool';
import { RunWatchPool } from '../services/runWatchPool';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('watch pool backoff resets', () => {
  it('clears stale run cooldowns after a successful startWatch fetch', async () => {
    const logger = createLogger();
    const watcherRegistry = new WatcherRegistry(logger);
    const backoffRegistry = new PollingBackoffRegistry(() => 15_000);
    const watcher: DevDocketRunWatcher = {
      id: 'test',
      label: 'Test watcher',
      canWatch: vi.fn().mockReturnValue(true),
      parseRunUrl: vi.fn().mockReturnValue({
        providerId: 'test',
        runId: 'run-1',
        displayName: 'Run 1',
        url: 'https://example.com/run/1',
        backoffKey: 'api.example.com',
      }),
      getRunStatus: vi.fn().mockResolvedValue({ overallState: 'running', jobs: [] }),
    };
    watcherRegistry.register(watcher);

    backoffRegistry.recordFailure(new PollingBackoffError({
      message: 'Rate limited',
      backoffKey: 'api.example.com',
      statusCode: 429,
      retryAfterMs: 60_000,
    }), 0);
    expect(backoffRegistry.isCoolingDown('api.example.com', 30_000)).toBe(true);

    const pool = new RunWatchPool(
      watcherRegistry,
      backoffRegistry,
      logger,
      () => false,
      () => {},
      () => 0,
    );

    const identifier: RunIdentifier = {
      providerId: 'test',
      runId: 'run-1',
      displayName: 'Run 1',
      url: 'https://example.com/run/1',
      backoffKey: 'api.example.com',
    };

    await pool.startWatch(identifier);

    expect(backoffRegistry.isCoolingDown('api.example.com', 30_000)).toBe(false);
  });

  it('clears stale PR cooldowns after a successful startPRWatch snapshot', async () => {
    const logger = createLogger();
    const watcherRegistry = new WatcherRegistry(logger);
    const prWatcherRegistry = new PRWatcherRegistry(logger);
    const backoffRegistry = new PollingBackoffRegistry(() => 15_000);
    const runPool = new RunWatchPool(
      watcherRegistry,
      backoffRegistry,
      logger,
      () => false,
      () => {},
      () => 0,
    );
    const prWatcher: DevDocketPRWatcher = {
      id: 'test-pr',
      label: 'Test PR watcher',
      canWatch: vi.fn().mockReturnValue(true),
      parsePRUrl: vi.fn().mockReturnValue({
        providerId: 'test-pr',
        prId: '42',
        displayName: 'PR #42',
        url: 'https://example.com/pr/42',
        repo: 'owner/repo',
        backoffKey: 'api.example.com',
      }),
      getPRRunsSnapshot: vi.fn().mockResolvedValue({ prState: 'open', runs: [] }),
    };
    prWatcherRegistry.register(prWatcher);

    backoffRegistry.recordFailure(new PollingBackoffError({
      message: 'Rate limited',
      backoffKey: 'api.example.com',
      statusCode: 429,
      retryAfterMs: 60_000,
    }), 0);
    expect(backoffRegistry.isCoolingDown('api.example.com', 30_000)).toBe(true);

    const prPool = new PRWatchPool(
      prWatcherRegistry,
      runPool,
      backoffRegistry,
      logger,
      () => false,
      () => {},
      () => {},
    );

    const identifier: PRIdentifier = {
      providerId: 'test-pr',
      prId: '42',
      displayName: 'PR #42',
      url: 'https://example.com/pr/42',
      repo: 'owner/repo',
      backoffKey: 'api.example.com',
    };

    await prPool.startPRWatch(identifier);

    expect(backoffRegistry.isCoolingDown('api.example.com', 30_000)).toBe(false);
  });

  it('keeps run cooldown active when a sibling watch hits rate limiting in the same batch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    try {
      const logger = createLogger();
      const watcherRegistry = new WatcherRegistry(logger);
      const backoffRegistry = new PollingBackoffRegistry(() => 15_000, 120_000, { jitterRatio: 0, random: () => 0 });
      let pollPhase = false;
      const watcher: DevDocketRunWatcher = {
        id: 'test',
        label: 'Test watcher',
        canWatch: vi.fn().mockReturnValue(true),
        parseRunUrl: vi.fn(),
        getRunStatus: vi.fn().mockImplementation(async (identifier: RunIdentifier) => {
          if (!pollPhase) {
            return { overallState: 'running', jobs: [] };
          }
          if (identifier.runId === 'run-2') {
            throw new PollingBackoffError({
              message: 'Rate limited',
              backoffKey: 'api.example.com',
              statusCode: 429,
              retryAfterMs: 60_000,
            });
          }
          return { overallState: 'running', jobs: [] };
        }),
      };
      watcherRegistry.register(watcher);

      const pool = new RunWatchPool(
        watcherRegistry,
        backoffRegistry,
        logger,
        () => false,
        () => {},
        () => 0,
      );

      await pool.startWatch({
        providerId: 'test',
        runId: 'run-1',
        displayName: 'Run 1',
        url: 'https://example.com/run/1',
        backoffKey: 'api.example.com',
      });
      await pool.startWatch({
        providerId: 'test',
        runId: 'run-2',
        displayName: 'Run 2',
        url: 'https://example.com/run/2',
        backoffKey: 'api.example.com',
      });

      pollPhase = true;
      await pool.pollRunWatches();

      expect(backoffRegistry.isCoolingDown('api.example.com', 30_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps PR cooldown active when a sibling watch hits rate limiting in the same batch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    try {
      const logger = createLogger();
      const watcherRegistry = new WatcherRegistry(logger);
      const prWatcherRegistry = new PRWatcherRegistry(logger);
      const backoffRegistry = new PollingBackoffRegistry(() => 15_000, 120_000, { jitterRatio: 0, random: () => 0 });
      const runPool = new RunWatchPool(
        watcherRegistry,
        backoffRegistry,
        logger,
        () => false,
        () => {},
        () => 0,
      );
      let pollPhase = false;
      const prWatcher: DevDocketPRWatcher = {
        id: 'test-pr',
        label: 'Test PR watcher',
        canWatch: vi.fn().mockReturnValue(true),
        parsePRUrl: vi.fn(),
        getPRRunsSnapshot: vi.fn().mockImplementation(async (identifier: PRIdentifier) => {
          if (!pollPhase) {
            return { prState: 'open', runs: [] };
          }
          if (identifier.prId === '43') {
            throw new PollingBackoffError({
              message: 'Rate limited',
              backoffKey: 'api.example.com',
              statusCode: 429,
              retryAfterMs: 60_000,
            });
          }
          return { prState: 'open', runs: [] };
        }),
      };
      prWatcherRegistry.register(prWatcher);

      const prPool = new PRWatchPool(
        prWatcherRegistry,
        runPool,
        backoffRegistry,
        logger,
        () => false,
        () => {},
        () => {},
      );

      await prPool.startPRWatch({
        providerId: 'test-pr',
        prId: '42',
        displayName: 'PR #42',
        url: 'https://example.com/pr/42',
        repo: 'owner/repo',
        backoffKey: 'api.example.com',
      });
      await prPool.startPRWatch({
        providerId: 'test-pr',
        prId: '43',
        displayName: 'PR #43',
        url: 'https://example.com/pr/43',
        repo: 'owner/repo',
        backoffKey: 'api.example.com',
      });

      pollPhase = true;
      await prPool.pollPRWatches();

      expect(backoffRegistry.isCoolingDown('api.example.com', 30_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
