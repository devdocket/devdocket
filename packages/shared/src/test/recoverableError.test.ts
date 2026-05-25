import { describe, expect, it, vi } from 'vitest';
import { isRecoverableError, type RecoverableError } from '../recoverableError';

describe('isRecoverableError', () => {
  it('returns true for recoverable errors', () => {
    const error = Object.assign(new Error('Recover me'), {
      recoverable: true as const,
      actions: [{
        label: 'Open settings',
        run: vi.fn(async () => undefined),
      }],
    }) satisfies RecoverableError;

    expect(isRecoverableError(error)).toBe(true);
  });

  it('returns true for plain objects from another extension bundle', () => {
    const crossBoundaryError = {
      name: 'RemoteRecoverableError',
      message: 'Needs recovery',
      recoverable: true as const,
      retryable: false,
    };

    expect(isRecoverableError(crossBoundaryError)).toBe(true);
  });

  it('returns false for non-recoverable values', () => {
    expect(isRecoverableError(new Error('nope'))).toBe(false);
    expect(isRecoverableError({ recoverable: false })).toBe(false);
    expect(isRecoverableError({ recoverable: true })).toBe(false);
    expect(isRecoverableError({ recoverable: true, message: 42 })).toBe(false);
    expect(isRecoverableError({ recoverable: true, message: 'oops', actions: 'bad' })).toBe(false);
    expect(isRecoverableError({ recoverable: true, message: 'oops', actions: [{ label: 'Retry' }] })).toBe(false);
    expect(isRecoverableError({ recoverable: true, message: 'oops', retryable: 'sometimes' })).toBe(false);
    expect(isRecoverableError(null)).toBe(false);
    expect(isRecoverableError('recoverable')).toBe(false);
  });
});
