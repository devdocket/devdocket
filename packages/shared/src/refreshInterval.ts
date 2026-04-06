import type { Logger } from './logger';

const DEFAULT_INTERVAL_SECONDS = 300;
const MINIMUM_INTERVAL_SECONDS = 60;
// Node.js setInterval uses a 32-bit signed ms delay; cap at ~24.8 days.
const MAXIMUM_INTERVAL_SECONDS = 2_147_483;

/**
 * Validates and clamps a refresh interval value.
 * Blank strings and values that do not convert to a finite number (for example
 * NaN, undefined, null, or non-numeric strings such as 'abc') fall back to
 * the default (300s).
 * Zero or negative values return 0 (disables periodic refresh).
 * Positive values below the minimum (60s) are clamped up.
 * Values above the maximum (~24.8 days) are clamped down.
 */
export function validateRefreshInterval(value: unknown, logger?: Logger): number {
  if (value == null || value === false) {
    return warnAndDefault(logger, String(value));
  }

  if (typeof value === 'string' && value.trim() === '') {
    return warnAndDefault(logger, JSON.stringify(value));
  }

  let num: number;
  try {
    num = Number(value);
  } catch {
    return warnAndDefault(logger, String(value));
  }

  if (!Number.isFinite(num)) {
    return warnAndDefault(logger, String(value));
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

function warnAndDefault(logger: Logger | undefined, repr: string): number {
  logger?.warn(
    `Refresh interval is not a valid number (got ${repr}), using default ${DEFAULT_INTERVAL_SECONDS} seconds`,
  );
  return DEFAULT_INTERVAL_SECONDS;
}
