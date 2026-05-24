export interface RecoverableErrorAction {
  readonly label: string;
  readonly run: () => Promise<void>;
  readonly retryAfterAction?: boolean;
}

/**
 * An error a provider or action can throw to surface recovery options in the UI.
 * Consumers will usually render `message` directly, but may substitute more
 * context-specific copy when the same recovery action is reused elsewhere.
 */
export interface RecoverableError extends Error {
  readonly recoverable: true;
  readonly actions?: ReadonlyArray<RecoverableErrorAction>;
  readonly retryable?: boolean;
}

export function isRecoverableError(error: unknown): error is RecoverableError {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as {
    recoverable?: unknown;
    message?: unknown;
    actions?: unknown;
    retryable?: unknown;
  };

  const hasValidActions = candidate.actions === undefined || (
    Array.isArray(candidate.actions)
    && candidate.actions.every(action => typeof action === 'object'
      && action !== null
      && typeof (action as { label?: unknown }).label === 'string'
      && typeof (action as { run?: unknown }).run === 'function'
      && ((action as { retryAfterAction?: unknown }).retryAfterAction === undefined
        || typeof (action as { retryAfterAction?: unknown }).retryAfterAction === 'boolean'))
  );
  const hasValidRetryable = candidate.retryable === undefined || typeof candidate.retryable === 'boolean';

  return candidate.recoverable === true
    && typeof candidate.message === 'string'
    && hasValidActions
    && hasValidRetryable;
}
