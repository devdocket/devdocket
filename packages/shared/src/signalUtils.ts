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
