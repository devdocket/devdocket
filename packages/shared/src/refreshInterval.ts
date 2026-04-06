import type { Logger } from './logger';

const DEFAULT_INTERVAL_SECONDS = 300;
const MINIMUM_INTERVAL_SECONDS = 60;

/**
 * Validates and clamps a refresh interval value.
 * Non-finite values (NaN, undefined) fall back to the default (300s).
 * null coerces to 0 and is clamped to the minimum (60s).
 * Values below the minimum (60s) are clamped up.
 */
export function validateRefreshInterval(value: unknown, logger?: Logger): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    logger?.warn(
      `Refresh interval is not a valid number (got ${String(value)}), using default ${DEFAULT_INTERVAL_SECONDS} seconds`,
    );
    return DEFAULT_INTERVAL_SECONDS;
  }

  if (num < MINIMUM_INTERVAL_SECONDS) {
    logger?.warn('Refresh interval clamped to minimum 60 seconds');
    return MINIMUM_INTERVAL_SECONDS;
  }

  return num;
}
