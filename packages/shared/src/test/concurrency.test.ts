import { describe, it, expect } from 'vitest';
import { runWorkerPool, runWorkerPoolSettled } from '../concurrency';

describe('runWorkerPool', () => {
  it('processes all items with a single worker', async () => {
    const items = [1, 2, 3];
    const results: number[] = [];
    
    await runWorkerPool(items, async (item, index) => {
      results[index] = item * 2;
    }, 1);
    
    expect(results).toEqual([2, 4, 6]);
  });

  it('processes all items with multiple workers', async () => {
    const items = [1, 2, 3, 4, 5];
    const results: number[] = [];
    
    await runWorkerPool(items, async (item, index) => {
      results[index] = item * 2;
    }, 3);
    
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it('preserves input order in results despite processing order', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const results: number[] = [];
    
    await runWorkerPool(items, async (item, index) => {
      // Simulate variable processing time using deterministic delays
      await new Promise(resolve => setTimeout(resolve, (items.length - item) * 2));
      results[index] = item * 2;
    }, 3);
    
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });

  it('respects maxConcurrency parameter', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    
    await runWorkerPool(items, async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(resolve => setTimeout(resolve, 10));
      currentConcurrent--;
    }, 3);
    
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('clamps effective concurrency to item count when maxConcurrency is larger', async () => {
    const items = [1, 2];
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    
    await runWorkerPool(items, async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(resolve => setTimeout(resolve, 10));
      currentConcurrent--;
    }, 10);
    
    expect(maxConcurrent).toBeLessThanOrEqual(items.length);
  });

  it('returns immediately for empty array', async () => {
    const results: number[] = [];
    
    await runWorkerPool([], async (item, index) => {
      results[index] = item;
    }, 3);
    
    expect(results).toEqual([]);
  });

  it('propagates AbortError from workers', async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const processed: number[] = [];
    
    await expect(
      runWorkerPool(items, async (item) => {
        if (item === 5) {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          throw error;
        }
        processed.push(item);
      }, 3)
    ).rejects.toThrow('Aborted');
    
    // Should have processed some items before abort
    expect(processed.length).toBeGreaterThan(0);
    expect(processed.length).toBeLessThan(100);
  });

  it('propagates non-AbortError immediately', async () => {
    const items = [1, 2, 3, 4, 5];
    
    await expect(
      runWorkerPool(items, async (item) => {
        if (item === 3) {
          throw new Error('Regular error');
        }
      }, 2)
    ).rejects.toThrow('Regular error');
  });
});

describe('runWorkerPoolSettled', () => {
  it('returns fulfilled results for successful items', async () => {
    const items = [1, 2, 3];
    
    const results = await runWorkerPoolSettled(items, async (item) => {
      return item * 2;
    }, 2);
    
    expect(results).toEqual([
      { status: 'fulfilled', value: 2 },
      { status: 'fulfilled', value: 4 },
      { status: 'fulfilled', value: 6 },
    ]);
  });

  it('captures rejected results for failed items', async () => {
    const items = [1, 2, 3, 4];
    
    const results = await runWorkerPoolSettled(items, async (item) => {
      if (item === 2 || item === 4) {
        throw new Error(`Failed: ${item}`);
      }
      return item * 2;
    }, 2);
    
    expect(results[0]).toEqual({ status: 'fulfilled', value: 2 });
    expect(results[1].status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason.message).toBe('Failed: 2');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 6 });
    expect(results[3].status).toBe('rejected');
    expect((results[3] as PromiseRejectedResult).reason.message).toBe('Failed: 4');
  });

  it('preserves result order matching input order', async () => {
    const items = [1, 2, 3, 4, 5];
    
    const results = await runWorkerPoolSettled(items, async (item) => {
      // Simulate variable processing time
      await new Promise(resolve => setTimeout(resolve, (5 - item) * 10));
      return item * 2;
    }, 3);
    
    expect(results.map(r => r.status === 'fulfilled' ? r.value : null))
      .toEqual([2, 4, 6, 8, 10]);
  });

  it('propagates AbortError without capturing it', async () => {
    const items = [1, 2, 3, 4, 5];
    
    await expect(
      runWorkerPoolSettled(items, async (item) => {
        if (item === 3) {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          throw error;
        }
        return item * 2;
      }, 2)
    ).rejects.toThrow('Aborted');
  });

  it('handles empty array gracefully', async () => {
    const results = await runWorkerPoolSettled([], async (item) => {
      return item;
    }, 3);
    
    expect(results).toEqual([]);
  });

  it('respects maxConcurrency parameter', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    
    await runWorkerPoolSettled(items, async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(resolve => setTimeout(resolve, 10));
      currentConcurrent--;
      return 0;
    }, 3);
    
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('allows partial success when some workers fail', async () => {
    const items = [1, 2, 3, 4, 5];
    
    const results = await runWorkerPoolSettled(items, async (item) => {
      if (item % 2 === 0) {
        throw new Error('Even number');
      }
      return item * 10;
    }, 2);
    
    expect(results[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect(results[1].status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 30 });
    expect(results[3].status).toBe('rejected');
    expect(results[4]).toEqual({ status: 'fulfilled', value: 50 });
  });
});
