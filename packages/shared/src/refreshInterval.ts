import type { Logger } from './logger';

const DEFAULT_INTERVAL_SECONDS = 300;
const MINIMUM_INTERVAL_SECONDS = 60;
// Node.js setInterval uses a 32-bit signed ms delay; cap at ~24.8 days.
const MAXIMUM_INTERVAL_SECONDS = 2_147_483;

/**
 * Validates and clamps a refresh interval value.
 * Non-finite values (NaN, undefined) and blank strings fall back to the default (300s).
 * Zero or negative values return 0 (disables periodic refresh).
 * Positive values below the minimum (60s) are clamped up.
 * Values above the maximum (~24.8 days) are clamped down.
 */
export function validateRefreshInterval(value: unknown, logger?: Logger): number {
  if (typeof value === 'string' && value.trim() === '') {
    logger?.warn(
      `Refresh interval is not a valid number (got ${JSON.stringify(value)}), using default ${DEFAULT_INTERVAL_SECONDS} seconds`,
    );
    return DEFAULT_INTERVAL_SECONDS;
  }

  const num = Number(value);
  if (!Number.isFinite(num)) {
    logger?.warn(
      `Refresh interval is not a valid number (got ${String(value)}), using default ${DEFAULT_INTERVAL_SECONDS} seconds`,
    );
    return DEFAULT_INTERVAL_SECONDS;
  }

  if (num <= 0) {
    return 0;
  }

  if (num < MINIMUM_INTERVAL_SECONDS) {
    logger?.warn(
      `Refresh interval clamped to minimum ${MINIMUM_INTERVAL_SECONDS} seconds`,
    );
    return MINIMUM_INTERVAL_SECONDS;
  }

  if (num > MAXIMUM_INTERVAL_SECONDS) {
    logger?.warn(
      `Refresh interval clamped to maximum ${MAXIMUM_INTERVAL_SECONDS} seconds`,
    );
    return MAXIMUM_INTERVAL_SECONDS;
  }

  return num;
}
