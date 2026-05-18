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
});
