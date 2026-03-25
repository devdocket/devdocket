import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window, workspace, authentication, lm } from 'vscode';
import { AiReviewAction } from '../aiReviewAction';

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

describe('AiReviewAction', () => {
  let action: AiReviewAction;

  beforeEach(() => {
    vi.clearAllMocks();
    action = new AiReviewAction();

    // Reset default mocks
    vi.mocked(authentication.getSession).mockResolvedValue({ accessToken: 'mock-token' } as never);
    vi.mocked(workspace.openTextDocument).mockResolvedValue({ uri: 'mock-doc-uri' } as never);
    vi.mocked(window.withProgress).mockImplementation(async (_options: unknown, task: Function) => {
      const progress = { report: vi.fn() };
      const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
      return task(progress, token);
    });
    vi.mocked(lm.selectChatModels).mockResolvedValue([{
      sendRequest: vi.fn().mockResolvedValue({
        text: (async function* () { yield 'Review feedback here'; })(),
      }),
    }]);
  });

  describe('canRun', () => {
    it('returns true for GitHub PR URLs', () => {
      const item = createWorkItem({ url: 'https://github.com/owner/repo/pull/42' });
      expect(action.canRun(item)).toBe(true);
    });

    it('returns true for Azure DevOps PR URLs', () => {
      const item = createWorkItem({ url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/99' });
      expect(action.canRun(item)).toBe(true);
    });

    it('returns false for GitHub issue URLs (not PRs)', () => {
      const item = createWorkItem({ url: 'https://github.com/owner/repo/issues/42' });
      expect(action.canRun(item)).toBe(false);
    });

    it('returns false for random URLs', () => {
      const item = createWorkItem({ url: 'https://example.com/something' });
      expect(action.canRun(item)).toBe(false);
    });

    it('returns false for items without URLs', () => {
      const item = createWorkItem({ url: undefined });
      expect(action.canRun(item)).toBe(false);
    });

    it('returns false for items with empty URL', () => {
      const item = createWorkItem({ url: '' });
      expect(action.canRun(item)).toBe(false);
    });
  });

  describe('isPrUrl', () => {
    it('matches GitHub PR URLs', () => {
      expect(action.isPrUrl('https://github.com/owner/repo/pull/1')).toBe(true);
      expect(action.isPrUrl('https://github.com/my-org/my-repo/pull/12345')).toBe(true);
    });

    it('matches Azure DevOps PR URLs', () => {
      expect(action.isPrUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/7')).toBe(true);
    });

    it('rejects non-PR URLs', () => {
      expect(action.isPrUrl('https://github.com/owner/repo/issues/42')).toBe(false);
      expect(action.isPrUrl('https://github.com/owner/repo')).toBe(false);
      expect(action.isPrUrl('https://example.com')).toBe(false);
    });
  });

  describe('run', () => {
    it('fetches diff and shows review in editor', async () => {
      // Mock global fetch for the diff request
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue('diff --git a/file.ts b/file.ts\n+added line'),
      });
      global.fetch = mockFetch;

      const item = createWorkItem();
      await action.run(item);

      // Verify fetch was called with the GitHub API
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo/pulls/42',
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: 'application/vnd.github.diff',
          }),
        }),
      );

      // Verify the review was shown in a document
      expect(workspace.openTextDocument).toHaveBeenCalledWith({
        content: expect.stringContaining('AI Code Review'),
        language: 'markdown',
      });
      expect(window.showTextDocument).toHaveBeenCalled();
    });

    it('shows error when diff fetch fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false });

      const item = createWorkItem();
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'AI Code Review: Failed to fetch PR diff',
      );
    });

    it('shows warning when no language model is available', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue('some diff'),
      });
      vi.mocked(lm.selectChatModels).mockResolvedValue([]);

      const item = createWorkItem();
      await action.run(item);

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        'AI Code Review: No language model available. Install GitHub Copilot.',
      );
    });

    it('does nothing when item has no URL', async () => {
      const item = createWorkItem({ url: undefined });
      await action.run(item);

      expect(window.withProgress).not.toHaveBeenCalled();
    });

    it('shows error when authentication session is not available', async () => {
      vi.mocked(authentication.getSession).mockResolvedValue(null as never);

      const item = createWorkItem();
      await action.run(item);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'AI Code Review: Failed to fetch PR diff',
      );
    });
  });

  describe('fetchDiff', () => {
    it('returns undefined for non-GitHub URLs', async () => {
      const result = await action.fetchDiff('https://example.com/not-a-pr');
      expect(result).toBeUndefined();
    });

    it('returns undefined when fetch throws', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('network error'));

      const result = await action.fetchDiff('https://github.com/owner/repo/pull/1');
      expect(result).toBeUndefined();
    });
  });

  describe('analyzeWithAi', () => {
    it('returns review text on success', async () => {
      const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
      const result = await action.analyzeWithAi('some diff content', token as never);

      expect(result).toContain('AI Code Review');
      expect(result).toContain('Review feedback here');
    });

    it('returns undefined and shows error when sendRequest throws', async () => {
      vi.mocked(lm.selectChatModels).mockResolvedValue([{
        sendRequest: vi.fn().mockRejectedValue(new Error('model error')),
      }]);

      const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
      const result = await action.analyzeWithAi('some diff', token as never);

      expect(result).toBeUndefined();
      expect(window.showErrorMessage).toHaveBeenCalledWith('AI Code Review: Analysis failed');
    });
  });
});
