import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTime } from '../utils/time';

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for very recent dates', () => {
    vi.useFakeTimers({ now: 1000 });
    expect(formatRelativeTime(new Date(1000))).toBe('just now');
  });

  it('returns a relative string for dates in the future', () => {
    vi.useFakeTimers({ now: 1000 });
    expect(formatRelativeTime(new Date(2000))).toBe('right now');
  });

  it('returns "1 minute ago" at exactly 60 seconds', () => {
    vi.useFakeTimers({ now: 60_000 });
    expect(formatRelativeTime(new Date(0))).toBe('1 minute ago');
  });

  it('returns "5 minutes ago" for 5 minutes', () => {
    vi.useFakeTimers({ now: 5 * 60_000 });
    expect(formatRelativeTime(new Date(0))).toBe('5 minutes ago');
  });

  it('returns "1 hour ago" at exactly 60 minutes', () => {
    vi.useFakeTimers({ now: 60 * 60_000 });
    expect(formatRelativeTime(new Date(0))).toBe('1 hour ago');
  });

  it('returns "1 day ago" for 24+ hours', () => {
    vi.useFakeTimers({ now: 24 * 60 * 60_000 });
    expect(formatRelativeTime(new Date(0))).toBe('1 day ago');
  });
});
