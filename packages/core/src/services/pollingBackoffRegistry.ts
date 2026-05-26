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
    return (this.policies.get(backoffKey)?.isCoolingDown(nowMs)) ?? false;
  }

  getRemainingMs(backoffKey: string | undefined, nowMs = Date.now()): number {
    if (!backoffKey) {
      return 0;
    }
    return this.policies.get(backoffKey)?.getRemainingMs(nowMs) ?? 0;
  }

  recordSuccess(backoffKey: string | undefined): void {
    if (!backoffKey) {
      return;
    }
    this.policies.get(backoffKey)?.recordSuccess();
  }

  recordFailure(error: unknown): PollingBackoffSnapshot | undefined {
    if (!isPollingBackoffError(error)) {
      return undefined;
    }

    const policy = this.getPolicy(error.backoffKey);
    const state = policy.recordFailure({ retryAfterMs: error.retryAfterMs });
    return {
      key: error.backoffKey,
      delayMs: state.delayMs,
      cooldownUntilMs: state.cooldownUntilMs,
    };
  }

  private getPolicy(backoffKey: string): BackoffPolicy {
    let policy = this.policies.get(backoffKey);
    if (!policy) {
      policy = new BackoffPolicy({
        baseDelayMs: this.getBaseDelayMs(),
        maxDelayMs: this.maxDelayMs,
        jitterRatio: 0,
      });
      this.policies.set(backoffKey, policy);
    }
    return policy;
  }
}
