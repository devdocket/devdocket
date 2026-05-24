import type { CancellationTokenLike } from './runWatcher';

/**
 * Creates an AbortError with the standard 'The operation was aborted.' message.
 * Use this instead of the three-line pattern for consistency:
 *   const error = new Error('The operation was aborted.');
 *   error.name = 'AbortError';
 *   throw error;
 */
export function createAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

type CancellationTokenWithEvents = CancellationTokenLike & {
  readonly onCancellationRequested?: (listener: () => void) => { dispose(): void };
};

/**
 * Bridges a VS Code-style cancellation token to an AbortController.
 *
 * The returned controller is aborted immediately when the token is already
 * cancelled, and otherwise aborts with a standard AbortError when the token
 * later fires. If the controller is aborted externally, the token subscription
 * is disposed to avoid leaking listeners.
 */
export function abortFromToken(token?: CancellationTokenWithEvents): AbortController {
  const controller = new AbortController();
  if (!token) {
    return controller;
  }

  if (token.isCancellationRequested) {
    controller.abort(createAbortError());
    return controller;
  }

  const subscription = token.onCancellationRequested?.(() => {
    if (!controller.signal.aborted) {
      controller.abort(createAbortError());
    }
  });

  if (subscription) {
    controller.signal.addEventListener('abort', () => subscription.dispose(), { once: true });
  }

  return controller;
}

function getAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : createAbortError();
}

export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(getAbortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(getAbortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function getSessionWithAuthFallback<T>(options: {
  interactive?: boolean;
  signal?: AbortSignal;
  getSilent: () => Promise<T | undefined>;
  getInteractive: () => Promise<T | undefined>;
}): Promise<T | undefined> {
  const { interactive = false, signal, getSilent, getInteractive } = options;
  if (signal?.aborted) {
    throw getAbortReason(signal);
  }

  const session = await raceWithAbort(getSilent(), signal);
  if (session || !interactive) {
    return session;
  }

  if (signal?.aborted) {
    throw getAbortReason(signal);
  }

  return raceWithAbort(getInteractive(), signal);
}

/**
 * Combines a cancellation signal with a per-request timeout into a single AbortSignal.
 * Node 18 compatible — does not use AbortSignal.any() (requires Node 20.3+).
 *
 * When the cancellation signal fires, the abort reason is preserved (typically AbortError).
 * When the timeout fires, the abort reason is a TimeoutError, matching AbortSignal.timeout() behavior.
 *
 * @param cancelSignal - Optional cancellation signal (e.g. from AbortController wired to CancellationToken)
 * @param timeoutMs - Per-request timeout in milliseconds
 * @returns A signal that aborts on whichever fires first
 */
export function combineSignals(cancelSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (!cancelSignal) {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();

  if (cancelSignal.aborted) {
    controller.abort(cancelSignal.reason);
    return controller.signal;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onCancel = () => controller.abort(cancelSignal.reason);

  // Cleanup handler clears timer and removes cancel listener
  const onAbort = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    cancelSignal.removeEventListener('abort', onCancel);
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });

  // Create timer BEFORE wiring cancel listener so timer is always defined
  // when onAbort runs, eliminating the race where cancel fires mid-setup.
  timer = setTimeout(() => {
    cancelSignal.removeEventListener('abort', onCancel);
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }, timeoutMs);
  timer.unref?.();

  cancelSignal.addEventListener('abort', onCancel, { once: true });

  // If cancelSignal fired between the aborted check above and addEventListener,
  // the combined signal may already be aborted. Clean up the timer.
  if (controller.signal.aborted) {
    clearTimeout(timer);
  }

  return controller.signal;
}
