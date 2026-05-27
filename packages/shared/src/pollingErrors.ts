/** Options for constructing a {@link PollingBackoffError}. */
export interface PollingBackoffErrorOptions {
  /** Human-readable explanation suitable for logs or surfaced warnings. */
  message: string;
  /** Stable key identifying the upstream quota bucket that should cool down together. */
  backoffKey: string;
  /** HTTP status code that triggered the backoff request, typically 429 or 503. */
  statusCode: number;
  /** Optional cooldown duration derived from upstream headers such as `Retry-After`. */
  retryAfterMs?: number;
}

/**
 * Error thrown by providers and watchers to signal that polling should back off.
 * Consumers can inspect {@link retryAfterMs} and {@link backoffKey} to coordinate cooldowns.
 */
export class PollingBackoffError extends Error {
  readonly backoffKey: string;
  readonly statusCode: number;
  readonly retryAfterMs?: number;

  constructor(options: PollingBackoffErrorOptions) {
    super(options.message);
    this.name = 'PollingBackoffError';
    this.backoffKey = options.backoffKey;
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Returns whether an unknown error has the shape of a {@link PollingBackoffError}.
 * @param error Candidate error value to inspect.
 * @returns `true` when the value includes the fields required to coordinate polling backoff.
 */
export function isPollingBackoffError(error: unknown): error is PollingBackoffError {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    name?: unknown;
    message?: unknown;
    backoffKey?: unknown;
    statusCode?: unknown;
    retryAfterMs?: unknown;
  };

  return candidate.name === 'PollingBackoffError'
    && typeof candidate.message === 'string'
    && typeof candidate.backoffKey === 'string'
    && typeof candidate.statusCode === 'number'
    && (candidate.retryAfterMs === undefined || typeof candidate.retryAfterMs === 'number');
}
