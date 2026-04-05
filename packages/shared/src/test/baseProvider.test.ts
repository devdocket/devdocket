import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseProvider, DiscoveredItem, EventEmitterLike } from '../baseProvider';

/** Minimal EventEmitter stub for testing. */
function createMockEmitter(): EventEmitterLike<DiscoveredItem[]> {
  const listeners: Array<(e: DiscoveredItem[]) => void> = [];
  return {
    event: (listener: (e: DiscoveredItem[]) => void) => {
      listeners.push(listener);
      return { dispose: () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); } };
    },
    fire: (data: DiscoveredItem[]) => { listeners.forEach(l => l(data)); },
    dispose: vi.fn(),
  };
}

/** Concrete subclass exposing internals for test purposes. */
class TestProvider extends BaseProvider {
  readonly id = 'test-provider';
  readonly label = 'Test Provider';

  refreshCalls = 0;
  backgroundRefreshCalls = 0;
  refreshError: Error | undefined;
  refreshDelay = 0;

  async refresh(): Promise<void> {
    this.refreshCalls++;
    if (this.refreshError) {
      throw this.refreshError;
    }
    this._onDidDiscoverItems.fire([{ externalId: 'item-1', title: 'Item 1' }]);
  }

  async refreshInBackground(): Promise<void> {
    if (this._isRefreshing) {
      return;
    }
    this._isRefreshing = true;
    try {
      this.backgroundRefreshCalls++;
      if (this.refreshDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, this.refreshDelay));
      }
      if (this.refreshError) {
        throw this.refreshError;
      }
      this._onDidDiscoverItems.fire([{ externalId: 'bg-1', title: 'BG Item' }]);
    } finally {
      this._isRefreshing = false;
    }
  }

  get isRefreshing(): boolean {
    return this._isRefreshing;
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
    it('starts an interval timer that calls refreshInBackground', () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(120);
      expect(provider.backgroundRefreshCalls).toBe(0);

      vi.advanceTimersByTime(120_000);
      expect(provider.backgroundRefreshCalls).toBe(1);

      vi.advanceTimersByTime(120_000);
      expect(provider.backgroundRefreshCalls).toBe(2);

      provider.dispose();
    });

    it('clamps intervals below 60 seconds to 60', () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(10);

      // At 10s nothing should fire
      vi.advanceTimersByTime(10_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      // At 60s the clamped interval fires
      vi.advanceTimersByTime(50_000);
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.dispose();
    });

    it('does nothing when interval is 0 or negative', () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(0);
      vi.advanceTimersByTime(120_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.startPeriodicRefresh(-5);
      vi.advanceTimersByTime(120_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.dispose();
    });

    it('does nothing for NaN or Infinity', () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(NaN);
      vi.advanceTimersByTime(120_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.startPeriodicRefresh(Infinity);
      vi.advanceTimersByTime(120_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      provider.dispose();
    });

    it('restarts the timer when called again', () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(60);
      vi.advanceTimersByTime(30_000); // halfway

      // Restart with a longer interval — old timer should be cleared
      provider.startPeriodicRefresh(120);

      vi.advanceTimersByTime(30_000); // 60s from original start
      expect(provider.backgroundRefreshCalls).toBe(0);

      vi.advanceTimersByTime(90_000); // 120s from restart
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.dispose();
    });
  });

  describe('stopPeriodicRefresh', () => {
    it('clears the interval so no more refreshes fire', () => {
      const provider = new TestProvider(createMockEmitter());

      provider.startPeriodicRefresh(60);
      vi.advanceTimersByTime(60_000);
      expect(provider.backgroundRefreshCalls).toBe(1);

      provider.stopPeriodicRefresh();

      vi.advanceTimersByTime(120_000);
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
    it('calls stopPeriodicRefresh and disposes the emitter', () => {
      const emitter = createMockEmitter();
      const provider = new TestProvider(emitter);

      provider.startPeriodicRefresh(60);
      provider.dispose();

      // Timer should be cleared — no more background calls
      vi.advanceTimersByTime(120_000);
      expect(provider.backgroundRefreshCalls).toBe(0);

      // Emitter.dispose should have been called
      expect(emitter.dispose).toHaveBeenCalledOnce();
    });

    it('is safe to call dispose() twice', () => {
      const emitter = createMockEmitter();
      const provider = new TestProvider(emitter);

      provider.dispose();
      expect(() => provider.dispose()).not.toThrow();

      // Emitter.dispose called twice — both should be safe
      expect(emitter.dispose).toHaveBeenCalledTimes(2);
    });
  });

  describe('_isRefreshing guard', () => {
    it('prevents concurrent background refreshes', async () => {
      vi.useRealTimers();
      const provider = new TestProvider(createMockEmitter());
      provider.refreshDelay = 50;

      // Start first refresh
      const first = provider.refreshInBackground();

      // While first is in-flight, second should be skipped
      await provider.refreshInBackground();
      expect(provider.backgroundRefreshCalls).toBe(1);

      await first;
      expect(provider.backgroundRefreshCalls).toBe(1);

      // After first completes, a new refresh should work
      await provider.refreshInBackground();
      expect(provider.backgroundRefreshCalls).toBe(2);

      provider.dispose();
    });

    it('resets after a refresh error', async () => {
      vi.useRealTimers();
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
      vi.useRealTimers();
      const provider = new TestProvider(createMockEmitter());
      const received: DiscoveredItem[][] = [];

      provider.onDidDiscoverItems(items => received.push(items));
      await provider.refresh();

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual([{ externalId: 'item-1', title: 'Item 1' }]);

      provider.dispose();
    });

    it('fires onDidDiscoverItems after background refresh', async () => {
      vi.useRealTimers();
      const provider = new TestProvider(createMockEmitter());
      const received: DiscoveredItem[][] = [];

      provider.onDidDiscoverItems(items => received.push(items));
      await provider.refreshInBackground();

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual([{ externalId: 'bg-1', title: 'BG Item' }]);

      provider.dispose();
    });

    it('fires via the periodic timer', () => {
      const provider = new TestProvider(createMockEmitter());
      const received: DiscoveredItem[][] = [];

      provider.onDidDiscoverItems(items => received.push(items));
      provider.startPeriodicRefresh(60);

      vi.advanceTimersByTime(60_000);
      expect(received).toHaveLength(1);

      provider.dispose();
    });
  });

  describe('refresh error resilience', () => {
    it('does not break the periodic interval', () => {
      const provider = new TestProvider(createMockEmitter());
      provider.refreshError = new Error('boom');

      provider.startPeriodicRefresh(60);

      // First tick — error thrown inside, but interval should survive
      vi.advanceTimersByTime(60_000);
      expect(provider.backgroundRefreshCalls).toBe(1);

      // Clear the error
      provider.refreshError = undefined;

      // Second tick — should fire normally
      vi.advanceTimersByTime(60_000);
      expect(provider.backgroundRefreshCalls).toBe(2);

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
});
