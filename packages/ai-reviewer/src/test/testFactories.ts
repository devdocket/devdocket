import { vi } from 'vitest';
import { WorkItemState } from '@devdocket/shared';
import type { WorkItem } from '@devdocket/shared';
import type { RepoManager } from '../repoManager';

export function createWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wc-test-1',
    title: 'Fix login redirect bug',
    notes: 'Some description',
    state: WorkItemState.New,
    providerId: 'github',
    externalId: 'owner/repo#123',
    url: 'https://github.com/owner/repo/pull/42',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function createMockRepoManager(): RepoManager {
  return {
    ensureWorktree: vi.fn().mockResolvedValue({
      worktreePath: '/mock/worktrees/pr-42',
      clonePath: '/mock/repos/owner-repo',
      org: 'owner',
      repo: 'repo',
      prNumber: '42',
      headRef: 'pr-42',
      baseRef: 'origin/main',
    }),
    getWorktreeInfo: vi.fn(),
    removeWorktree: vi.fn(),
    removeRepo: vi.fn(),
  } as unknown as RepoManager;
}
