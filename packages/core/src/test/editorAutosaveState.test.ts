import { describe, expect, it } from 'vitest';
import { initialAutosaveState, reduceAutosaveState } from '../webview/editor/autosaveState';

describe('reduceAutosaveState', () => {
  it('tracks pending, saving, and saved transitions', () => {
    const pending = reduceAutosaveState(initialAutosaveState, { type: 'edit' });
    expect(pending).toEqual({ status: 'pending' });

    const saving = reduceAutosaveState(pending, { type: 'send', requestId: 'save-1' });
    expect(saving).toEqual({ status: 'saving', requestId: 'save-1' });

    expect(reduceAutosaveState(saving, { type: 'ack', requestId: 'save-1', savedAt: 123 })).toEqual({
      status: 'saved',
      requestId: 'save-1',
      savedAt: 123,
    });
  });

  it('surfaces errors for the active save request', () => {
    const saving = reduceAutosaveState(initialAutosaveState, { type: 'send', requestId: 'save-1' });

    expect(reduceAutosaveState(saving, { type: 'error', requestId: 'save-1', message: 'disk full' })).toEqual({
      status: 'error',
      requestId: 'save-1',
      message: 'disk full',
    });
  });

  it('ignores stale acknowledgements after newer edits', () => {
    const saving = reduceAutosaveState(initialAutosaveState, { type: 'send', requestId: 'save-1' });
    const pending = reduceAutosaveState(saving, { type: 'edit' });

    expect(reduceAutosaveState(pending, { type: 'ack', requestId: 'save-1', savedAt: 123 })).toEqual({ status: 'pending' });
  });

  it('ignores acknowledgements for unknown request IDs', () => {
    const saving = reduceAutosaveState(initialAutosaveState, { type: 'send', requestId: 'save-1' });

    expect(reduceAutosaveState(saving, { type: 'ack', requestId: 'save-2', savedAt: 123 })).toBe(saving);
    expect(reduceAutosaveState(saving, { type: 'error', requestId: 'save-2', message: 'failed' })).toBe(saving);
  });
});
