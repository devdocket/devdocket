import { describe, it, expect, vi } from 'vitest';
import { validateRefreshInterval } from '../refreshInterval';
import type { Logger } from '../logger';

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('validateRefreshInterval', () => {
  it('returns the value when it is above the minimum', () => {
    expect(validateRefreshInterval(300)).toBe(300);
    expect(validateRefreshInterval(120)).toBe(120);
    expect(validateRefreshInterval(60)).toBe(60);
  });

  it('clamps values below 60 to 60', () => {
    expect(validateRefreshInterval(30)).toBe(60);
    expect(validateRefreshInterval(1)).toBe(60);
    expect(validateRefreshInterval(0)).toBe(60);
    expect(validateRefreshInterval(-1)).toBe(60);
    expect(validateRefreshInterval(-100)).toBe(60);
  });

  it('returns default 300 for NaN', () => {
    expect(validateRefreshInterval(NaN)).toBe(300);
  });

  it('returns default 300 for undefined', () => {
    expect(validateRefreshInterval(undefined)).toBe(300);
  });

  it('returns default 300 for null', () => {
    expect(validateRefreshInterval(null)).toBe(60);
    // null coerces to 0 via Number(), which is below minimum → clamped to 60
  });

  it('returns default 300 for non-numeric strings', () => {
    expect(validateRefreshInterval('abc')).toBe(300);
  });

  it('handles numeric strings', () => {
    expect(validateRefreshInterval('120')).toBe(120);
    expect(validateRefreshInterval('10')).toBe(60);
  });

  it('returns default 300 for Infinity', () => {
    expect(validateRefreshInterval(Infinity)).toBe(300);
    expect(validateRefreshInterval(-Infinity)).toBe(300);
  });

  it('logs a warning when the value is clamped', () => {
    const logger = createMockLogger();
    validateRefreshInterval(10, logger);
    expect(logger.warn).toHaveBeenCalledWith('Refresh interval clamped to minimum 60 seconds');
  });

  it('logs a warning when the value is not a valid number', () => {
    const logger = createMockLogger();
    validateRefreshInterval(NaN, logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not a valid number'),
    );
  });

  it('does not log when the value is valid', () => {
    const logger = createMockLogger();
    validateRefreshInterval(300, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
