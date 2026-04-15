import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTime } from '../utils/time';

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a "now"-style string for very recent dates', () => {
    vi.useFakeTimers({ now: 1000 });
    expect(formatRelativeTime(new Date(1000))).toMatch(/\bnow\b/i);
  });

  it('returns a "now"-style string for dates in the future', () => {
    vi.useFakeTimers({ now: 1000 });
    expect(formatRelativeTime(new Date(2000))).toMatch(/\bnow\b/i);
  });

  it('returns a 1-minute-ago style string at exactly 60 seconds', () => {
    vi.useFakeTimers({ now: 60_000 });
    expect(formatRelativeTime(new Date(0))).toMatch(/\b1\b.*\bminute\b.*\bago\b/i);
  });

  it('returns a 5-minutes-ago style string for 5 minutes', () => {
    vi.useFakeTimers({ now: 5 * 60_000 });
    expect(formatRelativeTime(new Date(0))).toMatch(/\b5\b.*\bminutes?\b.*\bago\b/i);
  });

  it('returns a 1-hour-ago style string at exactly 60 minutes', () => {
    vi.useFakeTimers({ now: 60 * 60_000 });
    expect(formatRelativeTime(new Date(0))).toMatch(/\b1\b.*\bhour\b.*\bago\b/i);
  });

  it('returns a 1-day-ago style string for 24+ hours', () => {
    vi.useFakeTimers({ now: 24 * 60 * 60_000 });
    expect(formatRelativeTime(new Date(0))).toMatch(/\b1\b.*\bday\b.*\bago\b/i);
  });
});
