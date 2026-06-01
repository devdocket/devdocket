import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogger: vi.fn(),
}));

import { resolveGitWorkForItem } from '../extension';
import { encodeWorkStartedDetail } from '../workStartedDetail';
import type { WorkItem, ActivityLogEntry } from '@devdocket/shared';
import { WorkItemState } from '@devdocket/shared';

function makeItem(log: ActivityLogEntry[]): WorkItem {
  return {
    id: 'wi-1',
    title: 'Sample',
    state: WorkItemState.InProgress,
    activityLog: log,
    createdAt: 0,
    updatedAt: 0,
  };
}

function entry(type: string, detail: string | undefined, ts = 0): ActivityLogEntry {
  return { type: type as ActivityLogEntry['type'], detail, timestamp: ts };
}

describe('resolveGitWorkForItem', () => {
  it('returns undefined for an item with no activity log', () => {
    const item: WorkItem = {
      id: 'wi-1',
      title: 'x',
      state: WorkItemState.New,
      activityLog: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(resolveGitWorkForItem(item)).toBeUndefined();
  });

  it('returns undefined when no work-started entry exists', () => {
    const item = makeItem([
      entry('note', 'just a note'),
      entry('state-change', 'New -> InProgress'),
    ]);
    expect(resolveGitWorkForItem(item)).toBeUndefined();
  });

  it('decodes a valid work-started entry into branch + worktreePath', () => {
    const detail = encodeWorkStartedDetail({
      branchName: 'feature/x',
      worktreePath: 'C:/tmp/wt',
      repoPath: 'C:/tmp/repo',
    });
    const item = makeItem([entry('work-started', detail)]);
    expect(resolveGitWorkForItem(item)).toEqual({
      branch: 'feature/x',
      worktreePath: 'C:/tmp/wt',
    });
  });

  it('omits branch when work-started entry has no branchName', () => {
    const detail = encodeWorkStartedDetail({
      worktreePath: 'C:/tmp/wt',
      repoPath: 'C:/tmp/repo',
    });
    const item = makeItem([entry('work-started', detail)]);
    expect(resolveGitWorkForItem(item)).toEqual({ worktreePath: 'C:/tmp/wt' });
  });

  it('omits worktreePath when work-started entry has no worktreePath', () => {
    const detail = encodeWorkStartedDetail({
      branchName: 'feature/x',
      repoPath: 'C:/tmp/repo',
    });
    const item = makeItem([entry('work-started', detail)]);
    expect(resolveGitWorkForItem(item)).toEqual({ branch: 'feature/x' });
  });

  it('returns undefined when work-started has neither branchName nor worktreePath', () => {
    const detail = encodeWorkStartedDetail({ repoPath: 'C:/tmp/repo' });
    const item = makeItem([entry('work-started', detail)]);
    expect(resolveGitWorkForItem(item)).toBeUndefined();
  });

  it('returns undefined when detail is malformed JSON', () => {
    const item = makeItem([entry('work-started', 'not-json')]);
    expect(resolveGitWorkForItem(item)).toBeUndefined();
  });

  it('returns undefined when detail is missing entirely', () => {
    const item = makeItem([entry('work-started', undefined)]);
    expect(resolveGitWorkForItem(item)).toBeUndefined();
  });

  it('uses the latest work-started entry when multiple exist', () => {
    const oldDetail = encodeWorkStartedDetail({
      branchName: 'old-branch',
      worktreePath: 'C:/old/wt',
      repoPath: 'C:/tmp/repo',
    });
    const newDetail = encodeWorkStartedDetail({
      branchName: 'new-branch',
      worktreePath: 'C:/new/wt',
      repoPath: 'C:/tmp/repo',
    });
    const item = makeItem([
      entry('work-started', oldDetail, 100),
      entry('note', 'in between'),
      entry('work-started', newDetail, 200),
    ]);
    expect(resolveGitWorkForItem(item)).toEqual({
      branch: 'new-branch',
      worktreePath: 'C:/new/wt',
    });
  });

  it('skips non-work-started entries when scanning in reverse', () => {
    const detail = encodeWorkStartedDetail({
      branchName: 'feature/x',
      repoPath: 'C:/tmp/repo',
    });
    const item = makeItem([
      entry('work-started', detail, 100),
      entry('note', 'later note', 200),
      entry('state-change', 'New -> InProgress', 300),
    ]);
    expect(resolveGitWorkForItem(item)).toEqual({ branch: 'feature/x' });
  });
});
