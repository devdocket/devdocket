/**
 * Executes a worker function over an array of items with controlled concurrency.
 * 
 * Uses a shared index to distribute work across multiple concurrent workers.
 * Workers process items in an indeterminate order. This function does not collect
 * or return results; callers that need to preserve input ordering can write to an
 * external array or map using the provided `index`.
 * 
 * The worker function is responsible for handling AbortSignal checks and throwing
 * AbortError when appropriate. If any worker throws, the error propagates and
 * terminates the Promise.all, though individual workers that have already claimed
 * items may continue processing until they naturally exit their loop.
 *
 * @param items - Array of items to process
 * @param worker - Async function that processes a single item and its index
 * @param maxConcurrency - Maximum number of workers to run in parallel (default: 3)
 * @returns Promise that resolves when all items are processed
 * 
 * @example
 * ```ts
 * const controller = new AbortController();
 * const signal = controller.signal;
 * const items = [1, 2, 3, 4, 5];
 * const results: number[] = [];
 * await runWorkerPool(items, async (item, index) => {
 *   if (signal.aborted) {
 *     const error = new Error('The operation was aborted.');
 *     error.name = 'AbortError';
 *     throw error;
 *   }
 *   const result = await processItem(item);
 *   results[index] = result;
 * }, 3);
 * ```
 */
export async function runWorkerPool<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  maxConcurrency: number = 3,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  // Validate concurrency parameter
  if (!Number.isFinite(maxConcurrency) || !Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`maxConcurrency must be a finite integer >= 1, got ${maxConcurrency}`);
  }

  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      await worker(items[currentIndex], currentIndex);
    }
  };

  const safeConcurrency = Number.isFinite(maxConcurrency) ? Math.max(1, Math.floor(maxConcurrency)) : 3;
  const workerCount = Math.min(safeConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

/**
 * Executes a worker function over an array of items with controlled concurrency,
 * returning an array of PromiseSettledResult objects.
 * 
 * Unlike runWorkerPool, this function captures errors per-item and returns them
 * in the results array, allowing for partial success when some items fail.
 * 
 * AbortErrors thrown by the worker will propagate and terminate the Promise.all,
 * though workers that have already claimed items may continue until they exit.
 * Other errors are captured in the results array as rejected promises.
 *
 * @param items - Array of items to process
 * @param worker - Async function that processes a single item and returns a result
 * @param maxConcurrency - Maximum number of workers to run in parallel (default: 3)
 * @returns Promise resolving to an array of settled results in input order
 * 
 * @example
 * ```ts
 * const controller = new AbortController();
 * const signal = controller.signal;
 * const repos = ['owner/repo1', 'owner/repo2'];
 * const results = await runWorkerPoolSettled(repos, async (repo) => {
 *   if (signal.aborted) {
 *     const error = new Error('The operation was aborted.');
 *     error.name = 'AbortError';
 *     throw error;
 *   }
 *   return await fetchRepoData(repo);
 * }, 3);
 * ```
 */
export async function runWorkerPoolSettled<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  maxConcurrency: number = 3,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);

  await runWorkerPool(items, async (item, index) => {
    try {
      const value = await worker(item, index);
      results[index] = { status: 'fulfilled', value };
    } catch (reason) {
      // Re-throw AbortError to stop all workers
      if (reason instanceof Error && reason.name === 'AbortError') {
        throw reason;
      }
      results[index] = { status: 'rejected', reason };
    }
  }, maxConcurrency);

  return results;
}
