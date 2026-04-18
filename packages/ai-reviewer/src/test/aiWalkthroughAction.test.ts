import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { window, commands, lm, mockLogOutputChannel } from 'vscode';
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

function createMockModel(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'mock-model-1',
    name: 'Mock Model',
    vendor: 'copilot',
    family: 'gpt-4o',
    sendRequest: vi.fn(),
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
  let mockOnModelSelected: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepoManager = createMockRepoManager();
    mockOnModelSelected = vi.fn();
    action = new AiWalkthroughAction(mockRepoManager, mockLogOutputChannel as never, mockOnModelSelected);

    // Default: single model available (auto-select)
    vi.mocked(lm.selectChatModels).mockResolvedValue([createMockModel()]);

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

    it('has label "AI Walkthrough"', () => {
      expect(action.label).toBe('AI Walkthrough');
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

  describe('run', () => {
    it('prompts for model selection before preparing worktree', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(lm.selectChatModels).toHaveBeenCalled();
    });

    it('calls onModelSelected with the chosen model', async () => {
      const model = createMockModel({ id: 'test-model' });
      vi.mocked(lm.selectChatModels).mockResolvedValue([model]);

      const item = createWorkItem();
      await action.run(item);

      expect(mockOnModelSelected).toHaveBeenCalledWith(model);
    });

    it('calls repoManager.ensureWorktree with the PR URL', async () => {
      const item = createWorkItem();
      await action.run(item);

      expect(mockRepoManager.ensureWorktree).toHaveBeenCalledWith('https://github.com/owner/repo/pull/42');
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

      expect(lm.selectChatModels).not.toHaveBeenCalled();
      expect(mockRepoManager.ensureWorktree).not.toHaveBeenCalled();
      expect(commands.executeCommand).not.toHaveBeenCalled();
    });

    it('aborts when no models are available', async () => {
      vi.mocked(lm.selectChatModels).mockResolvedValue([]);

      const item = createWorkItem();
      await action.run(item);

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        'AI Walkthrough: No language model available. Install GitHub Copilot.',
      );
      expect(mockRepoManager.ensureWorktree).not.toHaveBeenCalled();
      expect(commands.executeCommand).not.toHaveBeenCalled();
    });

    it('aborts when user cancels model selection', async () => {
      const model1 = createMockModel({ id: 'm1', name: 'A' });
      const model2 = createMockModel({ id: 'm2', name: 'B' });
      vi.mocked(lm.selectChatModels).mockResolvedValue([model1, model2]);
      vi.mocked(window.showQuickPick).mockResolvedValue(undefined as never);

      const item = createWorkItem();
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

      expect(commands.executeCommand).not.toHaveBeenCalled();
    });

    it('works without onModelSelected callback', async () => {
      const actionNoCallback = new AiWalkthroughAction(mockRepoManager, mockLogOutputChannel as never);
      const item = createWorkItem();
      await actionNoCallback.run(item);

      expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.chat.newChat');
    });
  });

  describe('constructor', () => {
    it('requires repoManager', () => {
      const rm = createMockRepoManager();
      const a = new AiWalkthroughAction(rm, mockLogOutputChannel as never);
      expect(a).toBeDefined();
      expect(a.id).toBe('ai-reviewer.walkthrough');
    });
  });
});
