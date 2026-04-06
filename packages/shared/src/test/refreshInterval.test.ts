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

  it('clamps positive values below 60 to 60', () => {
    expect(validateRefreshInterval(30)).toBe(60);
    expect(validateRefreshInterval(1)).toBe(60);
    expect(validateRefreshInterval(0.5)).toBe(60);
  });

  it('returns 0 for zero or negative values (disable refresh)', () => {
    expect(validateRefreshInterval(0)).toBe(0);
    expect(validateRefreshInterval(-1)).toBe(0);
    expect(validateRefreshInterval(-100)).toBe(0);
  });

  it('returns default 300 for null (treated as missing config)', () => {
    expect(validateRefreshInterval(null)).toBe(300);
  });

  it('returns default 300 for false', () => {
    expect(validateRefreshInterval(false)).toBe(300);
  });

  it('returns default 300 for NaN', () => {
    expect(validateRefreshInterval(NaN)).toBe(300);
  });

  it('returns default 300 for undefined', () => {
    expect(validateRefreshInterval(undefined)).toBe(300);
  });

  it('returns default 300 for non-numeric strings', () => {
    expect(validateRefreshInterval('abc')).toBe(300);
  });

  it('returns default 300 for blank/whitespace strings', () => {
    expect(validateRefreshInterval('')).toBe(300);
    expect(validateRefreshInterval('   ')).toBe(300);
    expect(validateRefreshInterval('\t')).toBe(300);
  });

  it('handles numeric strings', () => {
    expect(validateRefreshInterval('120')).toBe(120);
    expect(validateRefreshInterval('10')).toBe(60);
  });

  it('returns default 300 for Infinity', () => {
    expect(validateRefreshInterval(Infinity)).toBe(300);
    expect(validateRefreshInterval(-Infinity)).toBe(300);
  });

  it('clamps very large values to the maximum', () => {
    expect(validateRefreshInterval(3_000_000)).toBe(2_147_483);
    expect(validateRefreshInterval(Number.MAX_SAFE_INTEGER)).toBe(2_147_483);
  });

  it('logs a warning when the value is clamped to minimum', () => {
    const logger = createMockLogger();
    validateRefreshInterval(10, logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('minimum'),
    );
  });

  it('logs a warning when the value is clamped to maximum', () => {
    const logger = createMockLogger();
    validateRefreshInterval(3_000_000, logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('maximum'),
    );
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

  it('logs a warning for blank strings', () => {
    const logger = createMockLogger();
    validateRefreshInterval('', logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not a valid number'),
    );
  });

  it('returns default 300 for Symbol', () => {
    expect(validateRefreshInterval(Symbol('test'))).toBe(300);
  });

  it('does not log when disabling refresh', () => {
    const logger = createMockLogger();
    validateRefreshInterval(0, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
