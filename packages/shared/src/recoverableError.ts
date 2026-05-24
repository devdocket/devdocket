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
  return typeof error === 'object'
    && error !== null
    && (error as { recoverable?: unknown }).recoverable === true;
}
