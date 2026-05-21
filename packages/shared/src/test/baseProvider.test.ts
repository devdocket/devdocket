import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseProvider, ProviderItem, EventEmitterLike, WindowStateProvider, Disposable } from '../baseProvider';


/** Minimal EventEmitter stub for testing. */
function createMockEmitter(): EventEmitterLike<ProviderItem[]> {
  const listeners: Array<(e: ProviderItem[]) => void> = [];
  return {
    event: (listener: (e: ProviderItem[]) => void) => {
      listeners.push(listener);
      return { dispose: () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); } };
    },
    fire: (data: ProviderItem[]) => { listeners.forEach(l => l(data)); },
    dispose: vi.fn(),
  };
}

/** Creates a controllable WindowStateProvider for tests. */
function createMockWindowState(focused = true): {
  state: WindowStateProvider;
  setFocused: (f: boolean) => void;
} {
  let isFocused = focused;
  const listeners: Array<(f: boolean) => void> = [];
  const onDidChangeFocus = vi.fn((listener: (f: boolean) => void): Disposable => {
    listeners.push(listener);
    return { dispose: () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); } };
  });
  return {
    state: {
      get isFocused() { return isFocused; },
      onDidChangeFocus,
    },
    setFocused: (f: boolean) => {
      isFocused = f;
      listeners.forEach(l => l(f));
    },
  };
}

/** Concrete subclass exposing internals for test purposes. */
class TestProvider extends BaseProvider {
  readonly id = 'test-provider';
  readonly label = 'Test Provider';

  refreshCalls = 0;
  backgroundRefreshCalls = 0;
  refreshError: Error | undefined;
  /** Set to a deferred promise to simulate an in-flight refresh. */
  refreshGate: { promise: Promise<void>; resolve: () => void } | undefined;

  setErrorHandler(handler: (error: unknown) => void): void {
    this.onBackgroundRefreshError = handler;
  }

  async refresh(): Promise<void> {
    this.refreshCalls++;
    if (this.refreshError) {
      throw this.refreshError;
    }
    this._onDidDiscoverItems.fire([{ externalId: 'item-1', title: 'Item 1' }]);
  }

  protected async doBackgroundRefresh(): Promise<void> {
    this.backgroundRefreshCalls++;
    if (this.refreshGate) {
      await this.refreshGate.promise;
    }
    if (this.refreshError) {
      throw this.refreshError;
    }
    this._onDidDiscoverItems.fire([{ externalId: 'bg-1', title: 'BG Item' }]);
  }
}

describe('BaseProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('startPeriodicRefresh', () => {
    it('starts an interval timer that calls refreshInBackground', async () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(120);
      expect(provider.backgroundRefreshCalls).toBe(0);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.backgroundRefreshCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.backgroundRefreshCalls).toBe(2);

      provider.dispose();
    });

    it('clamps intervals below 60 seconds to 60', async () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(10);

      // At 10s nothing should fire
      await vi.advanceTimersByTimeAsync(10_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      // At 60s the clamped interval fires
      await vi.advanceTimersByTimeAsync(50_000);
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.dispose();
    });

    it('does nothing when interval is 0 or negative', async () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.startPeriodicRefresh(-5);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.dispose();
    });

    it('does nothing for NaN or Infinity', async () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(NaN);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.startPeriodicRefresh(Infinity);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.dispose();
    });

    it('restarts the timer when called again', async () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(60);
      await vi.advanceTimersByTimeAsync(30_000); // halfway

      // Restart with a longer interval — old timer should be cleared
      provider.startPeriodicRefresh(120);

      await vi.advanceTimersByTimeAsync(30_000); // 60s from original start
      expect(provider.backgroundRefreshCalls).toBe(0);

      await vi.advanceTimersByTimeAsync(90_000); // 120s from restart
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.dispose();
    });

    it('stops existing timer when called with invalid interval', async () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(60);

      // Calling with 0 should stop the running timer (conventional disable)
      provider.startPeriodicRefresh(0);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.dispose();
    });
  });

  describe('stopPeriodicRefresh', () => {
    it('clears the interval so no more refreshes fire', async () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(60);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.stopPeriodicRefresh();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.dispose();
    });

    it('is safe to call when no timer is running', () => {
      const provider = new TestProvider(createMockEmitter());
      expect(() => provider.stopPeriodicRefresh()).not.toThrow();
      provider.dispose();
    });

    it('is safe to call multiple times', () => {
      const provider = new TestProvider(createMockEmitter());
      provider.startPeriodicRefresh(60);
      provider.stopPeriodicRefresh();
      expect(() => provider.stopPeriodicRefresh()).not.toThrow();
      provider.dispose();
    });
  });

  describe('dispose', () => {
    it('calls stopPeriodicRefresh and disposes the emitter', async () => {
      const emitter = createMockEmitter();
      const provider = new TestProvider(emitter);

      provider.startPeriodicRefresh(60);
      provider.dispose();

      // Timer should be cleared — no more background calls
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      // Emitter.dispose should have been called
      expect(emitter.dispose).toHaveBeenCalledOnce();
    });

    it('is safe to call dispose() twice', () => {
      const emitter = createMockEmitter();
      const provider = new TestProvider(emitter);

      provider.dispose();
      expect(emitter.dispose).toHaveBeenCalledOnce();

      expect(() => provider.dispose()).not.toThrow();

      // Repeated dispose should be safe and not re-dispose the emitter
      expect(emitter.dispose).toHaveBeenCalledOnce();
    });

    it('prevents startPeriodicRefresh after dispose', async () => {
      const provider = new TestProvider(createMockEmitter());
      provider.dispose();

      provider.startPeriodicRefresh(60);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.backgroundRefreshCalls).toBe(0);
    });

    it('prevents refreshInBackground after dispose', async () => {
      const provider = new TestProvider(createMockEmitter());
      provider.dispose();

      await provider.refreshInBackground();
      expect(provider.backgroundRefreshCalls).toBe(0);
    });

    it('does not subscribe to window state after dispose', () => {
      const provider = new TestProvider(createMockEmitter());
      const windowState = createMockWindowState();
      provider.dispose();

      provider.setWindowState(windowState.state);

      expect(windowState.state.onDidChangeFocus).not.toHaveBeenCalled();
    });
  });

  describe('refreshInBackground concurrency guard', () => {
    it('prevents concurrent background refreshes', async () => {
      const provider = new TestProvider(createMockEmitter());

      // Create a gate to hold the first refresh in-flight
      let resolveGate!: () => void;
      provider.refreshGate = {
        promise: new Promise<void>(r => { resolveGate = r; }),
        resolve: () => resolveGate(),
      };

      // Start first refresh — it will suspend at the gate
      const first = provider.refreshInBackground();

      // While first is in-flight, second should be skipped
      await provider.refreshInBackground();
      expect(provider.backgroundRefreshCalls).toBe(1);

      // Release the gate so first completes
      resolveGate();
      await first;
      expect(provider.backgroundRefreshCalls).toBe(1);

      // Clear the gate for subsequent calls
      provider.refreshGate = undefined;

      // After first completes, a new refresh should work
      await provider.refreshInBackground();
      expect(provider.backgroundRefreshCalls).toBe(2);

      provider.dispose();
    });

    it('resets after a refresh error', async () => {
      const provider = new TestProvider(createMockEmitter());
      provider.refreshError = new Error('network down');

      // Refresh throws but guard should reset
      await expect(provider.refreshInBackground()).rejects.toThrow('network down');

      provider.refreshError = undefined;
      await provider.refreshInBackground();
      expect(provider.backgroundRefreshCalls).toBe(2);

      provider.dispose();
    });
  });

  describe('event emission', () => {
    it('fires onDidDiscoverItems after refresh', async () => {
      const provider = new TestProvider(createMockEmitter());
      const received: ProviderItem[][] = [];

      provider.onDidDiscoverItems(items => received.push(items));
      await provider.refresh();

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual([{ externalId: 'item-1', title: 'Item 1' }]);

      provider.dispose();
    });

    it('fires onDidDiscoverItems after background refresh', async () => {
      const provider = new TestProvider(createMockEmitter());
      const received: ProviderItem[][] = [];

      provider.onDidDiscoverItems(items => received.push(items));
      await provider.refreshInBackground();

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual([{ externalId: 'bg-1', title: 'BG Item' }]);

      provider.dispose();
    });

    it('fires via the periodic timer', async () => {
      const provider = new TestProvider(createMockEmitter());
      const received: ProviderItem[][] = [];

      provider.onDidDiscoverItems(items => received.push(items));
      provider.startPeriodicRefresh(60);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(received).toHaveLength(1);

      provider.dispose();
    });
  });

  describe('refresh error resilience', () => {
    it('does not break the periodic interval', async () => {
      const provider = new TestProvider(createMockEmitter());
      provider.refreshError = new Error('boom');

      provider.startPeriodicRefresh(60);

      // First tick — error thrown inside, but interval should survive
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.backgroundRefreshCalls).toBe(1);

      // Clear the error
      provider.refreshError = undefined;

      // Second tick — should fire normally
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.backgroundRefreshCalls).toBe(2);

      provider.dispose();
    });

    it('routes errors through the overridable onBackgroundRefreshError handler', async () => {
      const provider = new TestProvider(createMockEmitter());
      const errors: unknown[] = [];
      provider.setErrorHandler((err) => errors.push(err));
      provider.refreshError = new Error('custom handler');

      provider.startPeriodicRefresh(60);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);

      provider.dispose();
    });
  });

  describe('constructor', () => {
    it('exposes onDidDiscoverItems from the provided emitter', () => {
      const emitter = createMockEmitter();
      const provider = new TestProvider(emitter);
      expect(provider.onDidDiscoverItems).toBe(emitter.event);
      provider.dispose();
    });
  });

  describe('focus gating via setWindowState', () => {
    it('skips timer-fired refresh when window is unfocused', async () => {
      const provider = new TestProvider(createMockEmitter());
      const { state } = createMockWindowState(false);
      provider.setWindowState(state);

      provider.startPeriodicRefresh(60);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      // Second tick still skipped
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.dispose();
    });

    it('refreshes immediately on focus gain when overdue', async () => {
      const provider = new TestProvider(createMockEmitter());
      const { state, setFocused } = createMockWindowState(false);
      provider.setWindowState(state);

      provider.startPeriodicRefresh(60);

      // Timer fires while unfocused — skipped
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      // Gaining focus triggers the overdue refresh
      setFocused(true);
      // Allow the async refresh to settle
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.dispose();
    });

    it('runs an overdue refresh after an in-flight refresh completes', async () => {
      const provider = new TestProvider(createMockEmitter());
      const { state, setFocused } = createMockWindowState(false);
      provider.setWindowState(state);

      let resolveGate!: () => void;
      provider.refreshGate = {
        promise: new Promise<void>(r => { resolveGate = r; }),
        resolve: () => resolveGate(),
      };

      provider.startPeriodicRefresh(60);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      const firstRefresh = provider.refreshInBackground();
      expect(provider.backgroundRefreshCalls).toBe(1);

      setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.backgroundRefreshCalls).toBe(1);

      resolveGate();
      await firstRefresh;
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.backgroundRefreshCalls).toBe(2);

      provider.dispose();
    });

    it('does not refresh on focus gain when not overdue', async () => {
      const provider = new TestProvider(createMockEmitter());
      const { state, setFocused } = createMockWindowState(true);
      provider.setWindowState(state);

      provider.startPeriodicRefresh(60);

      // Focus toggled before timer fires — no overdue
      setFocused(false);
      setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.dispose();
    });

    it('allows timer-fired refresh when window is focused', async () => {
      const provider = new TestProvider(createMockEmitter());
      const { state } = createMockWindowState(true);
      provider.setWindowState(state);

      provider.startPeriodicRefresh(60);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.dispose();
    });

    it('works without window state set (backward compatible)', async () => {
      const provider = new TestProvider(createMockEmitter());
      // No setWindowState call — should behave as before
      provider.startPeriodicRefresh(60);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.dispose();
    });

    it('does not gate explicit refreshInBackground calls', async () => {
      const provider = new TestProvider(createMockEmitter());
      const { state } = createMockWindowState(false);
      provider.setWindowState(state);

      // Direct call should still work even when unfocused
      await provider.refreshInBackground();
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.dispose();
    });

    it('clears overdue flag on stopPeriodicRefresh', async () => {
      const provider = new TestProvider(createMockEmitter());
      const { state, setFocused } = createMockWindowState(false);
      provider.setWindowState(state);

      provider.startPeriodicRefresh(60);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.stopPeriodicRefresh();

      // Focus gain should not trigger refresh since timer was stopped
      setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.dispose();
    });

    it('disposes window state subscription on dispose', async () => {
      const provider = new TestProvider(createMockEmitter());
      const { state, setFocused } = createMockWindowState(false);
      provider.setWindowState(state);

      provider.startPeriodicRefresh(60);
      await vi.advanceTimersByTimeAsync(60_000);

      provider.dispose();

      // Focus gain after dispose should not trigger refresh
      setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.backgroundRefreshCalls).toBe(0);
    });

    it('replaces previous window state when called again', async () => {
      const provider = new TestProvider(createMockEmitter());
      const first = createMockWindowState(false);
      const second = createMockWindowState(true);

      provider.setWindowState(first.state);
      provider.setWindowState(second.state);

      provider.startPeriodicRefresh(60);

      // Timer fires — second state is focused, so it should refresh
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.backgroundRefreshCalls).toBe(1);

      // Old window state fire should not trigger anything
      first.setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      // Still only 1 (no spurious refresh from old subscription)
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.dispose();
    });

    it('triggers an overdue refresh when replacing unfocused state with a focused one', async () => {
      const provider = new TestProvider(createMockEmitter());
      const first = createMockWindowState(false);
      const second = createMockWindowState(true);

      provider.setWindowState(first.state);
      provider.startPeriodicRefresh(60);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.setWindowState(second.state);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.backgroundRefreshCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(0);
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.dispose();
    });
  });
});
