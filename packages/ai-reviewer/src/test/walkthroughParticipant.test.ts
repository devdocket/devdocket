import { describe, it, expect, beforeEach, vi } from 'vitest';
import { chat, lm, LanguageModelTextPart, ChatRequestTurn, ChatResponseTurn, ChatResponseMarkdownPart } from 'vscode';
import { WalkthroughParticipant } from '../walkthroughParticipant';
import type { RepoManager, WorktreeInfo } from '../repoManager';

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
    } as WorktreeInfo),
    getWorktreeInfo: vi.fn().mockReturnValue(undefined),
    removeWorktree: vi.fn(),
    removeRepo: vi.fn(),
  } as unknown as RepoManager;
}

function createMockRequest(prompt: string, model?: unknown) {
  return {
    prompt,
    model: model ?? {
      sendRequest: vi.fn().mockResolvedValue({
        stream: (async function* () {
          yield new LanguageModelTextPart('Here is the walkthrough...');
        })(),
      }),
    },
    toolInvocationToken: undefined,
  };
}

function createMockContext(history: unknown[] = []) {
  return { history };
}

function createMockResponse() {
  const markdownCalls: string[] = [];
  const progressCalls: string[] = [];
  return {
    markdown: vi.fn((text: string) => { markdownCalls.push(text); }),
    progress: vi.fn((text: string) => { progressCalls.push(text); }),
    markdownCalls,
    progressCalls,
  };
}

describe('WalkthroughParticipant', () => {
  let participant: WalkthroughParticipant;
  let mockRepoManager: RepoManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepoManager = createMockRepoManager();
    participant = new WalkthroughParticipant(mockRepoManager);
  });

  describe('register', () => {
    it('calls chat.createChatParticipant with correct ID', () => {
      participant.register();

      expect(chat.createChatParticipant).toHaveBeenCalledWith(
        'workcenter.walkthrough',
        expect.any(Function),
      );
    });

    it('returns a disposable', () => {
      const disposable = participant.register();
      expect(disposable).toBeDefined();
      expect(typeof disposable.dispose).toBe('function');
    });
  });

  describe('handleRequest', () => {
    it('asks for PR URL when none provided', async () => {
      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('tell me about something');
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(response.markdown).toHaveBeenCalledWith(
        expect.stringContaining('Please provide a GitHub PR URL'),
      );
    });

    it('calls repoManager.ensureWorktree for PR URL in prompt', async () => {
      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through this PR: https://github.com/owner/repo/pull/42');
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(mockRepoManager.ensureWorktree).toHaveBeenCalledWith(
        'https://github.com/owner/repo/pull/42',
      );
    });

    it('streams markdown to response', async () => {
      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through https://github.com/owner/repo/pull/42');
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(response.markdown).toHaveBeenCalledWith('Here is the walkthrough...');
    });

    it('shows error when ensureWorktree fails', async () => {
      vi.mocked(mockRepoManager.ensureWorktree).mockRejectedValue(new Error('Clone failed'));

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through https://github.com/owner/repo/pull/42');
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(response.markdown).toHaveBeenCalledWith(
        expect.stringContaining('Failed to prepare repository'),
      );
    });

    it('falls back to lm.selectChatModels when request.model is undefined', async () => {
      const mockModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Fallback model response');
          })(),
        }),
      };
      vi.mocked(lm.selectChatModels).mockResolvedValue([mockModel]);

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = {
        prompt: 'Walk me through https://github.com/owner/repo/pull/42',
        model: undefined,
        toolInvocationToken: undefined,
      };
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(lm.selectChatModels).toHaveBeenCalledWith({ family: 'gpt-4o' });
      expect(response.markdown).toHaveBeenCalledWith('Fallback model response');
    });

    it('shows error when no model is available', async () => {
      vi.mocked(lm.selectChatModels).mockResolvedValue([]);

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = {
        prompt: 'Walk me through https://github.com/owner/repo/pull/42',
        model: undefined,
        toolInvocationToken: undefined,
      };
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(response.markdown).toHaveBeenCalledWith(
        expect.stringContaining('No language model available'),
      );
    });

    it('finds PR URL from chat history when not in current prompt', async () => {
      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const historyTurn = new ChatRequestTurn(
        'Walk me through https://github.com/owner/repo/pull/42',
      );
      const request = createMockRequest('Tell me more about the tests');
      const context = createMockContext([historyTurn]);
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(mockRepoManager.ensureWorktree).toHaveBeenCalledWith(
        'https://github.com/owner/repo/pull/42',
      );
    });

    it('shows progress while preparing worktree', async () => {
      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through https://github.com/owner/repo/pull/42');
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(response.progress).toHaveBeenCalledWith(
        expect.stringContaining('worktree'),
      );
    });
  });
});
