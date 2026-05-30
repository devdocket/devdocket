import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { GitWorkResolverRegistry } from '../services/gitWorkResolverRegistry';
import type { WorkItem } from '../models/workItem';
import { WorkItemState } from '../models/workItem';

const sampleItem: WorkItem = {
  id: 'wi-1',
  title: 'Sample',
  state: WorkItemState.InProgress,
  activityLog: [],
  createdAt: 0,
  updatedAt: 0,
};

describe('GitWorkResolverRegistry', () => {
  let registry: GitWorkResolverRegistry;

  beforeEach(() => {
    registry = new GitWorkResolverRegistry();
  });

  it('returns undefined when no resolver is registered', () => {
    expect(registry.resolve(sampleItem)).toBeUndefined();
  });

  it('invokes the registered resolver and returns its normalised result', () => {
    const resolver = vi.fn().mockReturnValue({ branch: 'feature/x', worktreePath: 'C:/tmp/wt' });
    registry.register(resolver);
    const result = registry.resolve(sampleItem);
    expect(resolver).toHaveBeenCalledWith(sampleItem);
    expect(result).toEqual({ branch: 'feature/x', worktreePath: 'C:/tmp/wt' });
  });

  it('throws when registering a second resolver', () => {
    registry.register(() => undefined);
    expect(() => registry.register(() => undefined)).toThrow(/already registered/);
  });

  it('allows re-registering after the previous registration is disposed', () => {
    const first = registry.register(() => ({ branch: 'first' }));
    first.dispose();
    registry.register(() => ({ branch: 'second' }));
    expect(registry.resolve(sampleItem)).toEqual({ branch: 'second' });
  });

  it('returns undefined when the resolver throws', () => {
    registry.register(() => { throw new Error('boom'); });
    expect(registry.resolve(sampleItem)).toBeUndefined();
  });

  it('returns undefined when the resolver returns undefined', () => {
    registry.register(() => undefined);
    expect(registry.resolve(sampleItem)).toBeUndefined();
  });

  it('fires onDidChange when a resolver is registered and unregistered', () => {
    const listener = vi.fn();
    registry.onDidChange(listener);
    expect(listener).not.toHaveBeenCalled();

    const disposable = registry.register(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);

    disposable.dispose();
    expect(listener).toHaveBeenCalledTimes(2);

    disposable.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('dispose() clears the registration', () => {
    registry.register(() => ({ branch: 'b' }));
    registry.dispose();
    expect(registry.resolve(sampleItem)).toBeUndefined();
  });

  describe('output normalisation', () => {
    it('strips empty-string branch', () => {
      registry.register(() => ({ branch: '', worktreePath: 'C:/wt' }));
      expect(registry.resolve(sampleItem)).toEqual({ worktreePath: 'C:/wt' });
    });

    it('strips empty-string worktreePath', () => {
      registry.register(() => ({ branch: 'b', worktreePath: '' }));
      expect(registry.resolve(sampleItem)).toEqual({ branch: 'b' });
    });

    it('returns undefined when both fields are empty/missing', () => {
      registry.register(() => ({ branch: '', worktreePath: '' }));
      expect(registry.resolve(sampleItem)).toBeUndefined();
    });

    it('returns undefined for an empty object', () => {
      registry.register(() => ({}));
      expect(registry.resolve(sampleItem)).toBeUndefined();
    });

    it('drops extra non-contract properties', () => {
      registry.register(() => ({
        branch: 'b',
        worktreePath: 'C:/wt',
        extra: () => 1,
        another: Symbol('nope'),
      } as never));
      const result = registry.resolve(sampleItem);
      expect(result).toEqual({ branch: 'b', worktreePath: 'C:/wt' });
      expect(Object.keys(result!)).toEqual(['branch', 'worktreePath']);
    });

    it.each([
      ['null', null],
      ['array', []],
      ['string', 'nope'],
      ['number', 42],
      ['branch as non-string', { branch: 42, worktreePath: 'C:/wt' }],
      ['worktreePath as non-string', { branch: 'b', worktreePath: 99 }],
    ])('rejects %s and returns undefined', (_label, bad) => {
      registry.register(() => bad as never);
      // numeric worktreePath with valid branch should still keep branch.
      const result = registry.resolve(sampleItem);
      if (bad && typeof bad === 'object' && !Array.isArray(bad) && (bad as { branch?: unknown }).branch === 'b') {
        expect(result).toEqual({ branch: 'b' });
      } else if (bad && typeof bad === 'object' && !Array.isArray(bad) && (bad as { worktreePath?: unknown }).worktreePath === 'C:/wt') {
        expect(result).toEqual({ worktreePath: 'C:/wt' });
      } else {
        expect(result).toBeUndefined();
      }
    });
  });
});
