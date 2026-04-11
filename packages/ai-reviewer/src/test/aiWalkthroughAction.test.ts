import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { window, commands } from 'vscode';
import { AiWalkthroughAction } from '../aiWalkthroughAction';
import type { RepoManager } from '../repoManager';

function createWorkItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'wc-test-1',
    title: 'Fix login redirect bug',
    description: 'Some description',
    state: 'New',
    providerId: 'github',
    externalId: 'owner/repo#123',
    url: 'https://github.com/owner/repo/pull/42',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createMockRepoManager(): RepoManager {
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

describe('AiWalkthroughAction', () => {
  let action: AiWalkthroughAction;
  let mockRepoManager: RepoManager;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepoManager = createMockRepoManager();
    action = new AiWalkthroughAction(mockRepoManager);

    vi.mocked(window.withProgress).mockImplementation(async (_options: unknown, task: Function) => {
      const progress = { report: vi.fn() };
      const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
      return task(progress, token);
    });
  });

  describe('identity properties', () => {
    it('has id "ai-reviewer.walkthrough"', () => {
      expect(action.id).toBe('ai-reviewer.walkthrough');
    });

    it('has label "PR Walkthrough"', () => {
      expect(action.label).toBe('PR Walkthrough');
    });
  });

  describe('canRun', () => {
    it('returns true for GitHub PR URLs', () => {
      const item = createWorkItem({ url: 'https://github.com/owner/repo/pull/42' });
      expect(action.canRun(item)).toBe(true);
    });

    it('returns false for non-PR URLs', () => {
      const item = createWorkItem({ url: 'https://github.com/owner/repo/issues/42' });
      expect(action.canRun(item)).toBe(false);
    });

    it('returns false when item has no URL', () => {
      const item = createWorkItem({ url: undefined });
      expect(action.canRun(item)).toBe(false);
    });

    it('returns true for PR URLs with query strings', () => {
      const item = createWorkItem({ url: 'https://github.com/owner/repo/pull/42?diff=unified' });
      expect(action.canRun(item)).toBe(true);
    });

    it('returns true for PR URLs with fragments', () => {
      const item = createWorkItem({ url: 'https://github.com/owner/repo/pull/42#discussion_r123' });
      expect(action.canRun(item)).toBe(true);
    });
  });

  describe('parseGitHubPrUrl', () => {
    it('parses valid GitHub PR URLs', () => {
      const result = action.parseGitHubPrUrl('https://github.com/owner/repo/pull/42');
      expect(result).toEqual({ repo: 'owner/repo', prNumber: '42' });
    });

    it('returns undefined for non-PR URLs', () => {
      expect(action.parseGitHubPrUrl('https://github.com/owner/repo/issues/42')).toBeUndefined();
    });

    it('returns undefined for invalid URLs', () => {
      expect(action.parseGitHubPrUrl('not-a-url')).toBeUndefined();
    });
  });

  describe('run', () => {
    it('calls repoManager.ensureWorktree with the PR URL', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(mockRepoManager.ensureWorktree).toHaveBeenCalledWith('https://github.com/owner/repo/pull/42');
    });

    it('opens chat with correct query after preparing worktree', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.chat.open', {
        query: '@walkthrough Walk me through this PR: https://github.com/owner/repo/pull/42',
      });
    });

    it('shows error when ensureWorktree fails', async () => {
      vi.mocked(mockRepoManager.ensureWorktree).mockRejectedValue(new Error('Clone failed'));

      const item = createWorkItem();
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'PR Walkthrough: Failed to prepare repository — Clone failed',
      );
      expect(commands.executeCommand).not.toHaveBeenCalled();
    });

    it('does nothing when item has no URL', async () => {
      const item = createWorkItem({ url: undefined });
      await action.run(item);

      expect(mockRepoManager.ensureWorktree).not.toHaveBeenCalled();
      expect(commands.executeCommand).not.toHaveBeenCalled();
    });

    it('reports progress while preparing repository', async () => {
      const reportSpy = vi.fn();
      vi.mocked(window.withProgress).mockImplementation(async (_options: unknown, task: Function) => {
        const progress = { report: reportSpy };
        const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
        return task(progress, token);
      });

      const item = createWorkItem();
      await action.run(item);

      expect(reportSpy).toHaveBeenCalledWith({ message: 'Preparing repository...' });
    });

    it('does not open chat when cancelled', async () => {
      vi.mocked(window.withProgress).mockImplementation(async (_options: unknown, task: Function) => {
        const progress = { report: vi.fn() };
        const token = { isCancellationRequested: true, onCancellationRequested: vi.fn() };
        return task(progress, token);
      });

      const item = createWorkItem();
      await action.run(item);

      // ensureWorktree is called before cancellation check, but chat should not open
      expect(commands.executeCommand).not.toHaveBeenCalled();
    });
  });

  describe('constructor', () => {
    it('requires repoManager', () => {
      const rm = createMockRepoManager();
      const a = new AiWalkthroughAction(rm);
      expect(a).toBeDefined();
      expect(a.id).toBe('ai-reviewer.walkthrough');
    });
  });
});
