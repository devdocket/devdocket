/** Configuration for a {@link BackoffPolicy}. */
export interface BackoffPolicyOptions {
  /** Base delay to reset to after a successful request. */
  baseDelayMs: number;
  /** Upper bound for any computed cooldown. */
  maxDelayMs: number;
  /** Multiplier applied after each throttled failure. Defaults to 2. */
  multiplier?: number;
  /** Optional positive jitter ratio added on top of computed backoff. */
  jitterRatio?: number;
  /** Override randomness for deterministic tests. */
  random?: () => number;
}

/** Optional inputs when applying a throttling event to a {@link BackoffPolicy}. */
export interface BackoffApplyOptions {
  /** Reference time for calculating the new cooldown window. */
  nowMs?: number;
  /** Cooldown duration in milliseconds requested by the upstream service. */
  retryAfterMs?: number;
}

/** Snapshot of the current cooldown after a throttled failure is recorded. */
export interface BackoffStateSnapshot {
  delayMs: number;
  cooldownUntilMs: number;
}

/**
 * Tracks exponential polling backoff for one upstream quota bucket.
 * Call {@link recordFailure} when the service throttles a request and {@link recordSuccess}
 * after a successful retry to return to the base interval.
 */
export class BackoffPolicy {
  private baseDelayMs!: number;
  private maxDelayMs!: number;
  private readonly multiplier: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private currentDelayMs = 0;
  private cooldownUntilMs = 0;

  constructor(options: BackoffPolicyOptions) {
    this.multiplier = options.multiplier ?? 2;
    this.jitterRatio = Math.max(0, options.jitterRatio ?? 0);
    this.random = options.random ?? Math.random;
    this.applyOptions(options);
  }

  reset(): void {
    this.currentDelayMs = this.baseDelayMs;
    this.cooldownUntilMs = 0;
  }

  reconfigure(options: Pick<BackoffPolicyOptions, 'baseDelayMs' | 'maxDelayMs'>, nowMs = Date.now()): void {
    this.applyOptions(options, nowMs);
  }

  recordSuccess(): void {
    this.reset();
  }

  recordFailure(options: BackoffApplyOptions = {}): BackoffStateSnapshot {
    const nowMs = options.nowMs ?? Date.now();
    const retryAfterMs = Math.max(0, options.retryAfterMs ?? 0);
    const exponentialDelayMs = Math.min(this.maxDelayMs, this.currentDelayMs * this.multiplier);
    let delayMs = Math.min(this.maxDelayMs, Math.max(retryAfterMs, exponentialDelayMs));

    if (this.jitterRatio > 0) {
      delayMs = Math.min(this.maxDelayMs, Math.ceil(delayMs * (1 + (this.random() * this.jitterRatio))));
    }

    this.currentDelayMs = delayMs;
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, nowMs + delayMs);

    return {
      delayMs,
      cooldownUntilMs: this.cooldownUntilMs,
    };
  }

  isCoolingDown(nowMs = Date.now()): boolean {
    return this.getRemainingMs(nowMs) > 0;
  }

  getRemainingMs(nowMs = Date.now()): number {
    return Math.max(0, this.cooldownUntilMs - nowMs);
  }

  getCooldownUntilMs(): number | undefined {
    return this.cooldownUntilMs > 0 ? this.cooldownUntilMs : undefined;
  }

  getBaseDelayMs(): number {
    return this.baseDelayMs;
  }

  private applyOptions(options: Pick<BackoffPolicyOptions, 'baseDelayMs' | 'maxDelayMs'>, nowMs = Date.now()): void {
    if (!Number.isFinite(options.baseDelayMs) || options.baseDelayMs <= 0) {
      throw new Error('BackoffPolicy requires a positive baseDelayMs');
    }
    if (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs <= 0) {
      throw new Error('BackoffPolicy requires a positive maxDelayMs');
    }

    const remainingMs = this.getRemainingMs(nowMs);
    this.baseDelayMs = options.baseDelayMs;
    this.maxDelayMs = Math.max(options.maxDelayMs, options.baseDelayMs);
    this.currentDelayMs = Math.min(this.maxDelayMs, Math.max(this.baseDelayMs, this.currentDelayMs || this.baseDelayMs));
    this.cooldownUntilMs = remainingMs > 0
      ? nowMs + Math.min(remainingMs, this.maxDelayMs)
      : 0;
  }
}

/**
 * Parses an HTTP `Retry-After` header into a cooldown duration in milliseconds.
 * @param value Header value as either delta-seconds or an HTTP-date.
 * @param nowMs Reference time used when `value` is an HTTP-date.
 * @returns The requested delay in milliseconds, or `undefined` when the header is absent or invalid.
 */
export function parseRetryAfterHeader(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isNaN(parsedDate)) {
    return undefined;
  }

  return Math.max(0, parsedDate - nowMs);
}

/**
 * Parses a rate-limit reset header that reports a Unix timestamp in seconds.
 * @param value Header value containing the reset time in Unix seconds.
 * @returns The reset time as a Unix timestamp in milliseconds, or `undefined` when the header is absent or invalid.
 * Convert the result to a delay (for example, `Math.max(0, resetAtMs - Date.now())`) before passing it as `retryAfterMs`.
 */
export function parseRateLimitResetHeader(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }

  return Math.round(seconds * 1000);
}
