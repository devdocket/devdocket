import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseProvider } from '../baseProvider';
import type { DiscoveredItem } from '../types';
import type { CancellationToken } from 'vscode';

class TestProvider extends BaseProvider {
  readonly id = 'test';
  readonly label = 'Test Provider';

  doRefreshMock = vi.fn<(token?: CancellationToken) => Promise<void>>().mockResolvedValue(undefined);
  doBackgroundRefreshMock: (() => Promise<void>) | undefined;
  onBackgroundRefreshErrorMock = vi.fn<(err: unknown) => void>();

  protected async doRefresh(token?: CancellationToken): Promise<void> {
    await this.doRefreshMock(token);
  }

  protected override async doBackgroundRefresh(): Promise<void> {
    if (this.doBackgroundRefreshMock) {
      await this.doBackgroundRefreshMock();
    } else {
      await super.doBackgroundRefresh();
    }
  }

  protected override onBackgroundRefreshError(err: unknown): void {
    this.onBackgroundRefreshErrorMock(err);
  }

  // Expose for testing
  get isRefreshing(): boolean {
    return this._isRefreshing;
  }

  emitItems(items: DiscoveredItem[]): void {
    this.fireDiscoveredItems(items);
  }
}

describe('BaseProvider', () => {
  let provider: TestProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new TestProvider();
  });

  afterEach(() => {
    provider.dispose();
    vi.useRealTimers();
  });

  describe('refresh', () => {
    it('calls doRefresh and passes the cancellation token', async () => {
      const token = { isCancellationRequested: false } as CancellationToken;
      await provider.refresh(token);
      expect(provider.doRefreshMock).toHaveBeenCalledWith(token);
    });

    it('skips when already refreshing', async () => {
      let resolveFirst!: () => void;
      provider.doRefreshMock.mockImplementationOnce(() =>
        new Promise<void>(r => { resolveFirst = r; }),
      );

      const first = provider.refresh();
      // Second call should be skipped
      await provider.refresh();
      expect(provider.doRefreshMock).toHaveBeenCalledTimes(1);

      resolveFirst();
      await first;
    });

    it('resets _isRefreshing after success', async () => {
      await provider.refresh();
      expect(provider.isRefreshing).toBe(false);
    });

    it('resets _isRefreshing after failure', async () => {
      provider.doRefreshMock.mockRejectedValueOnce(new Error('fail'));
      await expect(provider.refresh()).rejects.toThrow('fail');
      expect(provider.isRefreshing).toBe(false);
    });
  });

  describe('fireDiscoveredItems', () => {
    it('fires items through the event emitter', () => {
      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);

      const items: DiscoveredItem[] = [
        { externalId: '1', title: 'Item 1' },
      ];
      provider.emitItems(items);
      expect(listener).toHaveBeenCalledWith(items);
    });
  });

  describe('startPeriodicRefresh', () => {
    it('calls doBackgroundRefresh on each interval tick', async () => {
      provider.doBackgroundRefreshMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      provider.startPeriodicRefresh(120);

      // First tick
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.doBackgroundRefreshMock).toHaveBeenCalledTimes(1);

      // Second tick
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.doBackgroundRefreshMock).toHaveBeenCalledTimes(2);
    });

    it('clamps interval to minimum 60 seconds', async () => {
      provider.doBackgroundRefreshMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      provider.startPeriodicRefresh(10);

      // Should not fire at 10 seconds
      await vi.advanceTimersByTimeAsync(10_000);
      expect(provider.doBackgroundRefreshMock).not.toHaveBeenCalled();

      // Should fire at 60 seconds
      await vi.advanceTimersByTimeAsync(50_000);
      expect(provider.doBackgroundRefreshMock).toHaveBeenCalledTimes(1);
    });

    it('does not start timer for zero or negative interval', async () => {
      provider.startPeriodicRefresh(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.doRefreshMock).not.toHaveBeenCalled();

      provider.startPeriodicRefresh(-5);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.doRefreshMock).not.toHaveBeenCalled();
    });

    it('does not start timer for non-finite interval', async () => {
      provider.startPeriodicRefresh(NaN);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.doRefreshMock).not.toHaveBeenCalled();

      provider.startPeriodicRefresh(Infinity);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.doRefreshMock).not.toHaveBeenCalled();
    });

    it('skips tick when already refreshing', async () => {
      let resolveRefresh!: () => void;
      provider.doBackgroundRefreshMock = vi.fn<() => Promise<void>>().mockImplementation(
        () => new Promise<void>(r => { resolveRefresh = r; }),
      );
      provider.startPeriodicRefresh(60);

      // First tick starts a long-running refresh
      vi.advanceTimersByTime(60_000);
      expect(provider.doBackgroundRefreshMock).toHaveBeenCalledTimes(1);

      // Second tick should be skipped because first is still running
      vi.advanceTimersByTime(60_000);
      expect(provider.doBackgroundRefreshMock).toHaveBeenCalledTimes(1);

      resolveRefresh();
      // Flush the .finally() callback
      await Promise.resolve();
      await Promise.resolve();
    });

    it('calls onBackgroundRefreshError when doBackgroundRefresh throws', async () => {
      const error = new Error('background fail');
      provider.doBackgroundRefreshMock = vi.fn<() => Promise<void>>().mockRejectedValue(error);
      provider.startPeriodicRefresh(60);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(provider.onBackgroundRefreshErrorMock).toHaveBeenCalledWith(error);
    });

    it('resets _isRefreshing after background refresh error', async () => {
      provider.doBackgroundRefreshMock = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('fail'));
      provider.startPeriodicRefresh(60);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(provider.isRefreshing).toBe(false);
    });

    it('replaces previous timer when called again', async () => {
      provider.doBackgroundRefreshMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      provider.startPeriodicRefresh(60);
      provider.startPeriodicRefresh(120);

      // Old 60s timer should not fire
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.doBackgroundRefreshMock).not.toHaveBeenCalled();

      // New 120s timer fires
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.doBackgroundRefreshMock).toHaveBeenCalledTimes(1);
    });

    it('defaults doBackgroundRefresh to doRefresh', async () => {
      // No doBackgroundRefreshMock override → base class calls doRefresh()
      provider.startPeriodicRefresh(60);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.doRefreshMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopPeriodicRefresh', () => {
    it('stops the timer', async () => {
      provider.doBackgroundRefreshMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      provider.startPeriodicRefresh(60);
      provider.stopPeriodicRefresh();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.doBackgroundRefreshMock).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('stops timer and disposes emitter', async () => {
      const listener = vi.fn();
      provider.onDidDiscoverItems(listener);
      provider.startPeriodicRefresh(60);

      provider.dispose();

      // Timer should be stopped — no more ticks
      await vi.advanceTimersByTimeAsync(120_000);
      expect(provider.doRefreshMock).not.toHaveBeenCalled();

      // Emitter should be disposed — no more events
      provider.emitItems([{ externalId: '1', title: 'x' }]);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
