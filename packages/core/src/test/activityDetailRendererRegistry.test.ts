import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ActivityDetailRendererRegistry } from '../services/activityDetailRendererRegistry';

describe('ActivityDetailRendererRegistry', () => {
  let registry: ActivityDetailRendererRegistry;

  beforeEach(() => {
    registry = new ActivityDetailRendererRegistry();
  });

  it('returns undefined when no renderer is registered', () => {
    expect(registry.render('work-started', 'anything')).toBeUndefined();
  });

  it('invokes the registered renderer and returns its result', () => {
    const renderer = vi.fn().mockReturnValue({ kind: 'text', text: 'pretty' });
    registry.register('work-started', renderer);
    const result = registry.render('work-started', '{"x":1}');
    expect(renderer).toHaveBeenCalledWith('{"x":1}');
    expect(result).toEqual({ kind: 'text', text: 'pretty' });
  });

  it('throws when registering a second renderer for the same type', () => {
    registry.register('work-started', () => undefined);
    expect(() => registry.register('work-started', () => undefined)).toThrow(/already registered/);
  });

  it('allows re-registering after the previous registration is disposed', () => {
    const first = registry.register('work-started', () => ({ kind: 'text', text: 'first' }));
    first.dispose();
    registry.register('work-started', () => ({ kind: 'text', text: 'second' }));
    expect(registry.render('work-started', undefined)).toEqual({ kind: 'text', text: 'second' });
  });

  it('dispose only removes the renderer when it is still the active one', () => {
    const first = registry.register('work-started', () => ({ kind: 'text', text: 'first' }));
    first.dispose();
    const secondRenderer = () => ({ kind: 'text' as const, text: 'second' });
    registry.register('work-started', secondRenderer);
    // Disposing the (already-disposed) first registration is a no-op.
    first.dispose();
    expect(registry.render('work-started', undefined)).toEqual({ kind: 'text', text: 'second' });
  });

  it('returns undefined and does not throw when the renderer throws', () => {
    registry.register('work-started', () => { throw new Error('boom'); });
    expect(registry.render('work-started', 'anything')).toBeUndefined();
  });

  it('passes undefined detail through to the renderer', () => {
    const renderer = vi.fn().mockReturnValue(undefined);
    registry.register('work-started', renderer);
    expect(registry.render('work-started', undefined)).toBeUndefined();
    expect(renderer).toHaveBeenCalledWith(undefined);
  });

  it('dispose() clears all registrations', () => {
    registry.register('work-started', () => ({ kind: 'text', text: 'a' }));
    registry.register('cleanup', () => ({ kind: 'text', text: 'b' }));
    registry.dispose();
    expect(registry.render('work-started', '')).toBeUndefined();
    expect(registry.render('cleanup', '')).toBeUndefined();
  });

  it('fires onDidChange when a renderer is registered and unregistered', () => {
    const listener = vi.fn();
    registry.onDidChange(listener);
    expect(listener).not.toHaveBeenCalled();

    const disposable = registry.register('work-started', () => undefined);
    expect(listener).toHaveBeenCalledTimes(1);

    disposable.dispose();
    expect(listener).toHaveBeenCalledTimes(2);

    // Disposing an already-disposed registration is a no-op (no extra event).
    disposable.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  describe('output shape validation', () => {
    it('accepts a valid text render', () => {
      registry.register('work-started', () => ({ kind: 'text', text: 'ok' }));
      expect(registry.render('work-started', '')).toEqual({ kind: 'text', text: 'ok' });
    });

    it('accepts a valid fields render', () => {
      registry.register('work-started', () => ({
        kind: 'fields',
        rows: [{ label: 'L', value: 'V' }, { label: 'L2', value: 'V2' }],
      }));
      expect(registry.render('work-started', '')).toEqual({
        kind: 'fields',
        rows: [{ label: 'L', value: 'V' }, { label: 'L2', value: 'V2' }],
      });
    });

    it.each([
      ['unknown kind', { kind: 'wat', text: 'x' }],
      ['text without string text', { kind: 'text', text: 42 }],
      ['fields without rows array', { kind: 'fields', rows: 'nope' }],
      ['fields with non-string label', { kind: 'fields', rows: [{ label: 42, value: 'v' }] }],
      ['fields with non-string value', { kind: 'fields', rows: [{ label: 'l', value: null }] }],
      ['fields with non-object row', { kind: 'fields', rows: ['not an object'] }],
      ['null', null],
      ['array', []],
      ['string', 'not a render'],
      ['number', 42],
      ['function', () => undefined],
    ])('rejects %s and returns undefined', (_label, bad) => {
      registry.register('work-started', () => bad as unknown as ReturnType<Parameters<typeof registry.register>[1]>);
      expect(registry.render('work-started', '')).toBeUndefined();
    });

    it('strips extra properties from text renders', () => {
      registry.register('work-started', () => ({
        kind: 'text',
        text: 'ok',
        nope: () => 1,
        extra: Symbol('not cloneable'),
      } as unknown as ReturnType<Parameters<typeof registry.register>[1]>));
      const result = registry.render('work-started', '');
      expect(result).toEqual({ kind: 'text', text: 'ok' });
      expect(Object.keys(result!)).toEqual(['kind', 'text']);
    });

    it('strips extra properties from fields renders and from each row', () => {
      registry.register('work-started', () => ({
        kind: 'fields',
        rows: [
          { label: 'L', value: 'V', extra: () => 1 },
          { label: 'L2', value: 'V2', another: Symbol('x') },
        ],
        extraTopLevel: 'should be dropped',
      } as unknown as ReturnType<Parameters<typeof registry.register>[1]>));
      const result = registry.render('work-started', '');
      expect(result).toEqual({
        kind: 'fields',
        rows: [{ label: 'L', value: 'V' }, { label: 'L2', value: 'V2' }],
      });
      expect(Object.keys(result!)).toEqual(['kind', 'rows']);
      for (const row of (result as { rows: Array<Record<string, unknown>> }).rows) {
        expect(Object.keys(row)).toEqual(['label', 'value']);
      }
    });
  });
});
