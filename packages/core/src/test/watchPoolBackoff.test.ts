import { describe, expect, it, vi } from 'vitest';
import { PollingBackoffError, type DevDocketRunWatcher, type RunIdentifier } from '@devdocket/shared';
import { WatcherRegistry } from '../services/watcherRegistry';
import { PRWatcherRegistry } from '../services/prWatcherRegistry';
import { PollingBackoffRegistry } from '../services/pollingBackoffRegistry';
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
});
