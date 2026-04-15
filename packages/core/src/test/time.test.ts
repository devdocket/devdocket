import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTime } from '../utils/time';

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for dates in the future', () => {
    vi.useFakeTimers({ now: 1000 });
    expect(formatRelativeTime(new Date(2000))).toBe('just now');
  });

  it('returns "just now" for less than 60 seconds ago', () => {
    vi.useFakeTimers({ now: 60_000 });
    expect(formatRelativeTime(new Date(1_000))).toBe('just now');
  });

  it('returns "1 minute ago" at exactly 60 seconds', () => {
    vi.useFakeTimers({ now: 60_000 });
    expect(formatRelativeTime(new Date(0))).toBe('1 minute ago');
  });

  it('returns "5 minutes ago" for 5 minutes', () => {
    vi.useFakeTimers({ now: 5 * 60_000 });
    expect(formatRelativeTime(new Date(0))).toBe('5 minutes ago');
  });

  it('returns "59 minutes ago" at boundary', () => {
    vi.useFakeTimers({ now: 59 * 60_000 });
    expect(formatRelativeTime(new Date(0))).toBe('59 minutes ago');
  });

  it('returns "1 hour ago" at exactly 60 minutes', () => {
    vi.useFakeTimers({ now: 60 * 60_000 });
    expect(formatRelativeTime(new Date(0))).toBe('1 hour ago');
  });

  it('returns "23 hours ago" at boundary', () => {
    vi.useFakeTimers({ now: 23 * 60 * 60_000 });
    expect(formatRelativeTime(new Date(0))).toBe('23 hours ago');
  });

  it('returns locale string for 24+ hours', () => {
    vi.useFakeTimers({ now: 24 * 60 * 60_000 });
    const date = new Date(0);
    expect(formatRelativeTime(date)).toBe(date.toLocaleString());
  });
});
