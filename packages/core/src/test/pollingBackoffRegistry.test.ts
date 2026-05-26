import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollingBackoffError } from '@devdocket/shared';
import { PollingBackoffRegistry } from '../services/pollingBackoffRegistry';

describe('PollingBackoffRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adopts updated base delays for existing backoff buckets while preserving cooldowns', () => {
    let baseDelayMs = 15_000;
    const registry = new PollingBackoffRegistry(() => baseDelayMs, 120_000);
    const error = new PollingBackoffError({
      message: 'Rate limited',
      backoffKey: 'api.github.com',
      statusCode: 429,
      retryAfterMs: 60_000,
    });

    const first = registry.recordFailure(error);
    expect(first?.delayMs).toBe(60_000);

    vi.advanceTimersByTime(30_000);
    expect(registry.getRemainingMs('api.github.com')).toBe(30_000);

    baseDelayMs = 30_000;
    expect(registry.getRemainingMs('api.github.com')).toBe(30_000);

    registry.recordSuccess('api.github.com');
    const second = registry.recordFailure(new PollingBackoffError({
      message: 'Rate limited again',
      backoffKey: 'api.github.com',
      statusCode: 429,
    }));

    expect(second?.delayMs).toBe(60_000);
  });
});
