import { describe, it, expect, vi, afterEach } from 'vitest';
import { abortFromToken, combineSignals, createAbortError, getSessionWithAuthFallback, raceWithAbort } from '../signalUtils';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('abortFromToken', () => {
  it('aborts immediately when the token is already cancelled', () => {
    const controller = abortFromToken({ isCancellationRequested: true });
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toMatchObject({ name: 'AbortError', message: 'The operation was aborted.' });
  });

  it('aborts when the token later requests cancellation', () => {
    let listener: (() => void) | undefined;
    const dispose = vi.fn();
    const controller = abortFromToken({
      isCancellationRequested: false,
      onCancellationRequested: (registeredListener) => {
        listener = registeredListener;
        return { dispose };
      },
    });

    listener?.();

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toMatchObject({ name: 'AbortError', message: 'The operation was aborted.' });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the token subscription when aborted externally', () => {
    const dispose = vi.fn();
    const controller = abortFromToken({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose }),
    });

    controller.abort(createAbortError());

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('combineSignals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns AbortSignal.timeout when cancelSignal is undefined', () => {
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    const signal = combineSignals(undefined, 5000);
    expect(spy).toHaveBeenCalledWith(5000);
    expect(signal).toBeDefined();
  });

  it('returns already-aborted signal when cancelSignal is pre-aborted', () => {
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);
    const combined = combineSignals(controller.signal, 5000);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe(reason);
  });

  it('aborts combined signal when cancelSignal fires before timeout', async () => {
    const cancelController = new AbortController();
    const combined = combineSignals(cancelController.signal, 60_000);

    expect(combined.aborted).toBe(false);

    const reason = new Error('user cancelled');
    cancelController.abort(reason);

    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe(reason);
  });

  it('aborts combined signal with TimeoutError when timeout fires first', async () => {
    vi.useFakeTimers();
    const cancelController = new AbortController();
    const combined = combineSignals(cancelController.signal, 100);

    expect(combined.aborted).toBe(false);

    vi.advanceTimersByTime(100);

    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBeInstanceOf(DOMException);
    expect((combined.reason as DOMException).name).toBe('TimeoutError');
    expect((combined.reason as DOMException).message).toBe('The operation timed out.');
    vi.useRealTimers();
  });

  it('cleans up timer when cancel fires (no lingering timers)', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const cancelController = new AbortController();
    combineSignals(cancelController.signal, 60_000);

    cancelController.abort();

    // Timer should have been cleared via the onAbort handler
    expect(clearSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cleans up cancel listener when timeout fires', () => {
    vi.useFakeTimers();
    const cancelController = new AbortController();
    const removeSpy = vi.spyOn(cancelController.signal, 'removeEventListener');
    combineSignals(cancelController.signal, 100);

    vi.advanceTimersByTime(100);

    // Cancel listener should have been removed
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    vi.useRealTimers();
  });

  it('handles race where cancel fires during listener setup', () => {
    // Simulate: cancelSignal aborts right after addEventListener
    const cancelController = new AbortController();
    const origAdd = cancelController.signal.addEventListener.bind(cancelController.signal);
    vi.spyOn(cancelController.signal, 'addEventListener').mockImplementation(
      (type: string, listener: any, options?: any) => {
        origAdd(type, listener, options);
        // Simulate immediate abort after listener is attached
        if (type === 'abort') {
          cancelController.abort(new Error('race condition'));
        }
      },
    );

    const combined = combineSignals(cancelController.signal, 60_000);
    expect(combined.aborted).toBe(true);
    expect((combined.reason as Error).message).toBe('race condition');
  });
});

describe('raceWithAbort', () => {
  it('rejects with the signal reason when already aborted', async () => {
    const controller = new AbortController();
    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError');
    controller.abort(timeoutError);

    await expect(raceWithAbort(Promise.resolve('ok'), controller.signal)).rejects.toBe(timeoutError);
  });

  it('rejects with the signal reason when aborted during the race', async () => {
    const controller = new AbortController();
    const pending = deferred<string>();
    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError');

    const promise = raceWithAbort(pending.promise, controller.signal);
    controller.abort(timeoutError);
    pending.resolve('ok');

    await expect(promise).rejects.toBe(timeoutError);
  });
});

describe('getSessionWithAuthFallback', () => {
  it('throws the signal reason when already aborted', async () => {
    const controller = new AbortController();
    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError');
    controller.abort(timeoutError);

    await expect(getSessionWithAuthFallback({
      interactive: true,
      signal: controller.signal,
      getSilent: async () => undefined,
      getInteractive: async () => 'session',
    })).rejects.toBe(timeoutError);
  });

  it('throws the signal reason when aborted synchronously inside getSilent', async () => {
    const controller = new AbortController();
    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError');

    await expect(getSessionWithAuthFallback({
      interactive: true,
      signal: controller.signal,
      getSilent: async () => {
        controller.abort(timeoutError);
        return undefined;
      },
      getInteractive: async () => 'session',
    })).rejects.toBe(timeoutError);
  });

  it('throws the signal reason when abort races the post-silent guard', async () => {
    const controller = new AbortController();
    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError');
    const silent = deferred<undefined>();

    const result = getSessionWithAuthFallback({
      interactive: true,
      signal: controller.signal,
      getSilent: () => silent.promise,
      getInteractive: async () => 'session',
    });

    await Promise.resolve();
    silent.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(timeoutError);

    await expect(result).rejects.toBe(timeoutError);
  });
});
