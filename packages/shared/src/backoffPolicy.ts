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

export interface BackoffApplyOptions {
  nowMs?: number;
  retryAfterMs?: number;
}

export interface BackoffStateSnapshot {
  delayMs: number;
  cooldownUntilMs: number;
}

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
    this.currentDelayMs = remainingMs > 0
      ? Math.min(this.maxDelayMs, Math.max(this.baseDelayMs, this.currentDelayMs || this.baseDelayMs))
      : this.baseDelayMs;
    this.cooldownUntilMs = remainingMs > 0
      ? nowMs + Math.min(remainingMs, this.maxDelayMs)
      : 0;
  }
}

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
