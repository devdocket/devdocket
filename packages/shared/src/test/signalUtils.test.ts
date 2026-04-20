import { describe, it, expect, vi, afterEach } from 'vitest';
import { combineSignals } from '../signalUtils';

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
