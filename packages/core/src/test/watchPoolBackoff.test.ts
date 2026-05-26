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
});
