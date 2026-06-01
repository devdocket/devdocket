import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const existsSyncMock = vi.fn();
vi.mock('fs', () => ({
  existsSync: (p: string) => existsSyncMock(p),
}));

import { resolveGitWorkData, clearWorktreeExistsCache } from '../services/gitWorkData';
import { GitWorkResolverRegistry } from '../services/gitWorkResolverRegistry';
import type { WorkItem } from '../models/workItem';
import { WorkItemState } from '../models/workItem';

const item: WorkItem = {
  id: 'wi-1',
  title: 't',
  state: WorkItemState.InProgress,
  activityLog: [],
  createdAt: 0,
  updatedAt: 0,
};

describe('resolveGitWorkData', () => {
  let registry: GitWorkResolverRegistry;

  beforeEach(() => {
    registry = new GitWorkResolverRegistry();
    existsSyncMock.mockReset();
    clearWorktreeExistsCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined when registry is undefined', () => {
    expect(resolveGitWorkData(undefined, item)).toBeUndefined();
  });

  it('returns undefined when the resolver returns nothing', () => {
    expect(resolveGitWorkData(registry, item)).toBeUndefined();
  });

  it('returns branch-only data without calling existsSync', () => {
    registry.register(() => ({ branch: 'feature/x' }));
    const result = resolveGitWorkData(registry, item);
    expect(result).toEqual({ branch: 'feature/x' });
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('annotates worktreeExists when a worktreePath is present', () => {
    existsSyncMock.mockReturnValue(true);
    registry.register(() => ({ branch: 'b', worktreePath: 'C:/wt' }));
    expect(resolveGitWorkData(registry, item)).toEqual({
      branch: 'b',
      worktreePath: 'C:/wt',
      worktreeExists: true,
    });
  });

  it('treats existsSync throws as "not present"', () => {
    existsSyncMock.mockImplementation(() => { throw new Error('EACCES'); });
    registry.register(() => ({ worktreePath: 'C:/wt' }));
    expect(resolveGitWorkData(registry, item)).toEqual({
      worktreePath: 'C:/wt',
      worktreeExists: false,
    });
  });

  it('caches existsSync results across calls within the TTL window', () => {
    existsSyncMock.mockReturnValue(true);
    registry.register(() => ({ worktreePath: 'C:/wt' }));
    resolveGitWorkData(registry, item);
    resolveGitWorkData(registry, item);
    resolveGitWorkData(registry, item);
    expect(existsSyncMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes the cache after the TTL expires', () => {
    existsSyncMock.mockReturnValue(true);
    registry.register(() => ({ worktreePath: 'C:/wt' }));
    resolveGitWorkData(registry, item);
    expect(existsSyncMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6_000);
    existsSyncMock.mockReturnValue(false);
    const result = resolveGitWorkData(registry, item);
    expect(existsSyncMock).toHaveBeenCalledTimes(2);
    expect(result?.worktreeExists).toBe(false);
  });

  it('caches different paths independently', () => {
    existsSyncMock.mockImplementation((p: string) => p === 'C:/a');
    let toReturn: 'a' | 'b' = 'a';
    registry.register(() => ({ worktreePath: toReturn === 'a' ? 'C:/a' : 'C:/b' }));
    expect(resolveGitWorkData(registry, item)?.worktreeExists).toBe(true);
    toReturn = 'b';
    expect(resolveGitWorkData(registry, item)?.worktreeExists).toBe(false);
    expect(existsSyncMock).toHaveBeenCalledTimes(2);
    // Repeat both — should hit cache for both paths.
    toReturn = 'a';
    expect(resolveGitWorkData(registry, item)?.worktreeExists).toBe(true);
    toReturn = 'b';
    expect(resolveGitWorkData(registry, item)?.worktreeExists).toBe(false);
    expect(existsSyncMock).toHaveBeenCalledTimes(2);
  });
});
