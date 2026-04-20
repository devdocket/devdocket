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

  const onCancel = () => controller.abort(cancelSignal.reason);
  cancelSignal.addEventListener('abort', onCancel, { once: true });

  const timer = setTimeout(() => {
    cancelSignal.removeEventListener('abort', onCancel);
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }, timeoutMs);

  controller.signal.addEventListener('abort', () => {
    clearTimeout(timer);
    cancelSignal.removeEventListener('abort', onCancel);
  }, { once: true });

  return controller.signal;
}
