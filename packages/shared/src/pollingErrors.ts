export interface PollingBackoffErrorOptions {
  message: string;
  backoffKey: string;
  statusCode: number;
  retryAfterMs?: number;
}

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
