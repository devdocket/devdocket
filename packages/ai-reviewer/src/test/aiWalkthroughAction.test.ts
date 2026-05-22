import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { window, commands, mockLogOutputChannel } from 'vscode';
import { AiWalkthroughAction } from '../aiWalkthroughAction';
import type { RepoManager } from '../repoManager';
import { createWorkItem, createMockRepoManager } from './testFactories';

describe('AiWalkthroughAction', () => {
  let action: AiWalkthroughAction;
  let mockRepoManager: RepoManager;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepoManager = createMockRepoManager();
    action = new AiWalkthroughAction(mockRepoManager, mockLogOutputChannel as never);

    // Default: user confirms the prompt
    vi.mocked(window.showWarningMessage).mockResolvedValue('Continue' as never);

    vi.mocked(window.withProgress).mockImplementation(async (_options: unknown, task: Function) => {
      const progress = { report: vi.fn() };
      const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
      return task(progress, token);
    });
  });

  describe('identity and inheritance', () => {
    it('has id "ai-reviewer.walkthrough"', () => {
      expect(action.id).toBe('ai-reviewer.walkthrough');
    });

    it('has label "AI Walkthrough"', () => {
      expect(action.label).toBe('AI Walkthrough');
    });

    it('inherits canRun from BasePrAction', () => {
      expect(action.canRun(createWorkItem({ url: 'https://github.com/o/r/pull/1' }))).toBe(true);
      expect(action.canRun(createWorkItem({ url: 'https://dev.azure.com/o/p/_git/r/pullrequest/1' }))).toBe(true);
      expect(action.canRun(createWorkItem({ url: 'https://github.com/o/r/issues/1' }))).toBe(false);
      expect(action.canRun(createWorkItem({ url: undefined }))).toBe(false);
    });

    it('inherits isPrUrl from BasePrAction', () => {
      expect(action.isPrUrl('https://github.com/owner/repo/pull/42')).toBe(true);
      expect(action.isPrUrl('https://dev.azure.com/org/project/_git/repo/pullrequest/42')).toBe(true);
      expect(action.isPrUrl('https://github.com/owner/repo/issues/42')).toBe(false);
    });
  });

  describe('run', () => {
    it('shows confirmation prompt before proceeding', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        'AI Walkthrough will use AI to analyze and walk through this PR. Continue?',
        { modal: true },
        'Continue',
      );
    });

    it('proceeds when user confirms', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(mockRepoManager.ensureWorktree).toHaveBeenCalledWith('https://github.com/owner/repo/pull/42', expect.anything());
      expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.chat.newChat');
    });

    it('aborts when user dismisses confirmation', async () => {
      vi.mocked(window.showWarningMessage).mockResolvedValue(undefined as never);

      const item = createWorkItem();
      await action.run(item);

      expect(window.withProgress).not.toHaveBeenCalled();
      expect(mockRepoManager.ensureWorktree).not.toHaveBeenCalled();
      expect(commands.executeCommand).not.toHaveBeenCalled();
    });

    it('calls repoManager.ensureWorktree with the PR URL', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(mockRepoManager.ensureWorktree).toHaveBeenCalledWith('https://github.com/owner/repo/pull/42', expect.anything());
    });

    it('opens chat with correct query after preparing worktree', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.chat.newChat');
      expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.chat.open', {
        query: '@walkthrough Walk me through this PR: https://github.com/owner/repo/pull/42',
      });
    });

    it('shows error when ensureWorktree fails', async () => {
      vi.mocked(mockRepoManager.ensureWorktree).mockRejectedValue(new Error('Clone failed'));

      const item = createWorkItem();
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'AI Walkthrough: Failed to prepare repository — Clone failed',
      );
      expect(commands.executeCommand).not.toHaveBeenCalled();
    });

    it('does nothing when item has no URL', async () => {
      const item = createWorkItem({ url: undefined });
      await action.run(item);

      expect(window.showWarningMessage).not.toHaveBeenCalled();
      expect(window.withProgress).not.toHaveBeenCalled();
      expect(mockRepoManager.ensureWorktree).not.toHaveBeenCalled();
      expect(commands.executeCommand).not.toHaveBeenCalled();
    });

    it('skips confirmation for non-PR URLs', async () => {
      const item = createWorkItem({ url: 'https://github.com/owner/repo/issues/42' });
      await action.run(item);

      expect(window.showWarningMessage).not.toHaveBeenCalled();
      expect(window.withProgress).not.toHaveBeenCalled();
      expect(mockRepoManager.ensureWorktree).not.toHaveBeenCalled();
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

      expect(commands.executeCommand).not.toHaveBeenCalled();
    });
  });
});
