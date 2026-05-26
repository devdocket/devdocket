import { describe, expect, it } from 'vitest';
import { BackoffPolicy, parseRateLimitResetHeader, parseRetryAfterHeader } from '../backoffPolicy';

describe('BackoffPolicy', () => {
  it('resets to the base delay after success', () => {
    const policy = new BackoffPolicy({ baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0, random: () => 0 });

    const first = policy.recordFailure({ nowMs: 0 });
    expect(first.delayMs).toBe(2_000);

    policy.recordSuccess();

    const second = policy.recordFailure({ nowMs: 0 });
    expect(second.delayMs).toBe(2_000);
  });

  it('honors Retry-After when it exceeds exponential backoff', () => {
    const policy = new BackoffPolicy({ baseDelayMs: 15_000, maxDelayMs: 60 * 60 * 1000, jitterRatio: 0, random: () => 0 });

    const state = policy.recordFailure({ nowMs: 5_000, retryAfterMs: 60_000 });

    expect(state.delayMs).toBe(60_000);
    expect(state.cooldownUntilMs).toBe(65_000);
    expect(policy.isCoolingDown(64_999)).toBe(true);
    expect(policy.isCoolingDown(65_000)).toBe(false);
  });

  it('caps exponential backoff at the configured maximum', () => {
    const policy = new BackoffPolicy({ baseDelayMs: 10_000, maxDelayMs: 25_000, jitterRatio: 0, random: () => 0 });

    expect(policy.recordFailure({ nowMs: 0 }).delayMs).toBe(20_000);
    expect(policy.recordFailure({ nowMs: 0 }).delayMs).toBe(25_000);
    expect(policy.recordFailure({ nowMs: 0 }).delayMs).toBe(25_000);
  });
});

describe('parseRetryAfterHeader', () => {
  it('parses delta seconds', () => {
    expect(parseRetryAfterHeader('60')).toBe(60_000);
  });

  it('parses HTTP-date values', () => {
    const nowMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    const retryAfter = new Date(nowMs + 45_000).toUTCString();

    expect(parseRetryAfterHeader(retryAfter, nowMs)).toBe(45_000);
  });
});

describe('parseRateLimitResetHeader', () => {
  it('parses GitHub epoch-second reset values', () => {
    expect(parseRateLimitResetHeader('1735689900')).toBe(1_735_689_900_000);
  });
});
