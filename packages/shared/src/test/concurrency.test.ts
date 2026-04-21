import { describe, it, expect, vi } from 'vitest';
import { runWorkerPool, runWorkerPoolSettled } from '../concurrency';

describe('runWorkerPool', () => {
  it('returns immediately for empty array', async () => {
    const worker = vi.fn();
    await runWorkerPool([], worker, 3);
    expect(worker).not.toHaveBeenCalled();
  });

  it('processes single item correctly', async () => {
    const results: number[] = [];
    await runWorkerPool([42], async (item, index) => {
      results[index] = item * 2;
    }, 3);
    expect(results).toEqual([84]);
  });

  it('caps worker count to item count', async () => {
    let workerId = 0;
    const activeWorkers = new Set<number>();
    let maxConcurrent = 0;

    await runWorkerPool([1, 2], async (item) => {
      const id = workerId++;
      activeWorkers.add(id);
      maxConcurrent = Math.max(maxConcurrent, activeWorkers.size);
      await new Promise(resolve => setTimeout(resolve, 10));
      activeWorkers.delete(id);
    }, 10);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('processes items concurrently with specified limit', async () => {
    const activeCount = { current: 0 };
    let maxConcurrent = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await runWorkerPool(items, async (item, index) => {
      activeCount.current++;
      maxConcurrent = Math.max(maxConcurrent, activeCount.current);
      // Use item-based delay for determinism
      await new Promise(resolve => setTimeout(resolve, 10 + index % 3));
      activeCount.current--;
    }, 3);

    expect(maxConcurrent).toBe(3);
  });

  it('preserves input order in results when using index', async () => {
    const results: string[] = [];
    const items = ['a', 'b', 'c', 'd', 'e'];

    await runWorkerPool(items, async (item, index) => {
      // Use index-based delay for determinism
      await new Promise(resolve => setTimeout(resolve, 10 + (index % 3) * 5));
      results[index] = item.toUpperCase();
    }, 3);

    expect(results).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('propagates worker errors to caller', async () => {
    await expect(
      runWorkerPool([1, 2, 3], async (item) => {
        if (item === 2) {
          throw new Error('Worker failed');
        }
      }, 2)
    ).rejects.toThrow('Worker failed');
  });

  it('uses default concurrency of 3 when not specified', async () => {
    const activeCount = { current: 0 };
    let maxConcurrent = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await runWorkerPool(items, async () => {
      activeCount.current++;
      maxConcurrent = Math.max(maxConcurrent, activeCount.current);
      await new Promise(resolve => setTimeout(resolve, 10));
      activeCount.current--;
    });

    expect(maxConcurrent).toBe(3);
  });
});

describe('runWorkerPoolSettled', () => {
  it('returns empty array for empty input', async () => {
    const results = await runWorkerPoolSettled([], async () => 42, 3);
    expect(results).toEqual([]);
  });

  it('preserves input order in results', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWorkerPoolSettled(items, async (item, index) => {
      // Use index-based delay for determinism
      await new Promise(resolve => setTimeout(resolve, 10 + (index % 3) * 5));
      return item * 2;
    }, 3);

    expect(results).toHaveLength(5);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 2 });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 4 });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 6 });
    expect(results[3]).toEqual({ status: 'fulfilled', value: 8 });
    expect(results[4]).toEqual({ status: 'fulfilled', value: 10 });
  });

  it('captures worker errors as rejected results', async () => {
    const items = [1, 2, 3];
    const results = await runWorkerPoolSettled(items, async (item) => {
      if (item === 2) {
        throw new Error('Item 2 failed');
      }
      return item * 10;
    }, 2);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect(results[1]).toEqual({ status: 'rejected', reason: expect.objectContaining({ message: 'Item 2 failed' }) });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 30 });
  });

  it('handles non-Error throws gracefully', async () => {
    const items = [1, 2];
    const results = await runWorkerPoolSettled(items, async (item) => {
      if (item === 2) {
        throw 'plain string error';
      }
      return item;
    }, 2);

    expect(results[1]).toEqual({ status: 'rejected', reason: 'plain string error' });
  });

  it('re-throws AbortError to stop all workers', async () => {
    const processedItems: number[] = [];
    const items = [1, 2, 3, 4, 5];

    await expect(
      runWorkerPoolSettled(items, async (item) => {
        processedItems.push(item);
        if (item === 2) {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        return item;
      }, 3)
    ).rejects.toThrow('The operation was aborted.');
  });

  it('returns mix of fulfilled and rejected results', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWorkerPoolSettled(items, async (item) => {
      if (item % 2 === 0) {
        throw new Error(`Even number ${item}`);
      }
      return item * 100;
    }, 3);

    expect(results).toHaveLength(5);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 100 });
    expect(results[1].status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 300 });
    expect(results[3].status).toBe('rejected');
    expect(results[4]).toEqual({ status: 'fulfilled', value: 500 });
  });

  it('processes items concurrently up to limit', async () => {
    const activeCount = { current: 0 };
    let maxConcurrent = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await runWorkerPoolSettled(items, async (item) => {
      activeCount.current++;
      maxConcurrent = Math.max(maxConcurrent, activeCount.current);
      await new Promise(resolve => setTimeout(resolve, 10));
      activeCount.current--;
      return item;
    }, 4);

    expect(maxConcurrent).toBe(4);
  });

  it('uses default concurrency of 3 when not specified', async () => {
    const activeCount = { current: 0 };
    let maxConcurrent = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await runWorkerPoolSettled(items, async (item) => {
      activeCount.current++;
      maxConcurrent = Math.max(maxConcurrent, activeCount.current);
      await new Promise(resolve => setTimeout(resolve, 10));
      activeCount.current--;
      return item;
    });

    expect(maxConcurrent).toBe(3);
  });
});
