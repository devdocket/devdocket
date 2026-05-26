import { BackoffPolicy, isPollingBackoffError } from '@devdocket/shared';

export interface PollingBackoffSnapshot {
  key: string;
  delayMs: number;
  cooldownUntilMs: number;
}

export class PollingBackoffRegistry {
  private readonly policies = new Map<string, BackoffPolicy>();

  constructor(
    private readonly getBaseDelayMs: () => number,
    private readonly maxDelayMs = 60 * 60 * 1000,
  ) {}

  isCoolingDown(backoffKey: string | undefined, nowMs = Date.now()): boolean {
    if (!backoffKey) {
      return false;
    }
    return this.getPolicy(backoffKey, nowMs).isCoolingDown(nowMs);
  }

  getRemainingMs(backoffKey: string | undefined, nowMs = Date.now()): number {
    if (!backoffKey) {
      return 0;
    }
    return this.getPolicy(backoffKey, nowMs).getRemainingMs(nowMs);
  }

  recordSuccess(backoffKey: string | undefined, nowMs = Date.now()): void {
    if (!backoffKey) {
      return;
    }
    this.getPolicy(backoffKey, nowMs).recordSuccess();
  }

  recordFailure(error: unknown, nowMs = Date.now()): PollingBackoffSnapshot | undefined {
    if (!isPollingBackoffError(error)) {
      return undefined;
    }

    const policy = this.getPolicy(error.backoffKey, nowMs);
    const state = policy.recordFailure({ nowMs, retryAfterMs: error.retryAfterMs });
    return {
      key: error.backoffKey,
      delayMs: state.delayMs,
      cooldownUntilMs: state.cooldownUntilMs,
    };
  }

  private getPolicy(backoffKey: string, nowMs = Date.now()): BackoffPolicy {
    const baseDelayMs = this.getBaseDelayMs();
    let policy = this.policies.get(backoffKey);
    if (!policy) {
      policy = new BackoffPolicy({
        baseDelayMs,
        maxDelayMs: this.maxDelayMs,
        jitterRatio: 0,
      });
      this.policies.set(backoffKey, policy);
      return policy;
    }

    if (policy.getBaseDelayMs() !== baseDelayMs) {
      policy.reconfigure({
        baseDelayMs,
        maxDelayMs: this.maxDelayMs,
      }, nowMs);
    }
    return policy;
  }
}
