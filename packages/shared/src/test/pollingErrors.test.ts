import { describe, expect, it } from 'vitest';
import { PollingBackoffError, isPollingBackoffError } from '../pollingErrors';

describe('isPollingBackoffError', () => {
  it('recognizes PollingBackoffError instances', () => {
    expect(isPollingBackoffError(new PollingBackoffError({
      message: 'Rate limited',
      backoffKey: 'api.github.com',
      statusCode: 429,
      retryAfterMs: 60_000,
    }))).toBe(true);
  });

  it('recognizes structural polling backoff errors across package boundaries', () => {
    const crossPackageShape = {
      name: 'PollingBackoffError',
      message: 'Rate limited',
      backoffKey: 'api.github.com',
      statusCode: 429,
      retryAfterMs: 60_000,
    };

    expect(isPollingBackoffError(crossPackageShape)).toBe(true);
  });

  it('rejects incomplete lookalikes', () => {
    expect(isPollingBackoffError({ name: 'PollingBackoffError', backoffKey: 'api.github.com' })).toBe(false);
  });
});
