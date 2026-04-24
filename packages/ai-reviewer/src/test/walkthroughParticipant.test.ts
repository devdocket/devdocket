import { describe, it, expect, beforeEach, vi } from 'vitest';
import { chat, lm, LanguageModelTextPart, LanguageModelToolCallPart, ChatRequestTurn, mockLogOutputChannel } from 'vscode';
import { WalkthroughParticipant } from '../walkthroughParticipant';
import type { RepoManager } from '../repoManager';
import { createMockRepoManager } from './testFactories';

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
    participant = new WalkthroughParticipant(mockRepoManager, mockLogOutputChannel as never);
  });

  describe('register', () => {
    it('calls chat.createChatParticipant with correct ID', () => {
      participant.register();

      expect(chat.createChatParticipant).toHaveBeenCalledWith(
        'devdocket.walkthrough',
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

      expect(lm.selectChatModels).toHaveBeenCalledWith();
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

    it('invokes real tools via lm.invokeTool and continues the loop', async () => {
      const mockModel = {
        sendRequest: vi.fn()
          .mockResolvedValueOnce({
            stream: (async function* () {
              yield new LanguageModelToolCallPart('call-1', 'devdocket-readFile', { worktreePath: '/mock', filePath: 'src/index.ts' });
            })(),
          })
          .mockResolvedValueOnce({
            stream: (async function* () {
              yield new LanguageModelTextPart('File contents analyzed.');
            })(),
          }),
      };

      vi.mocked(lm.invokeTool).mockResolvedValue({
        content: [new LanguageModelTextPart('file content here')],
      });

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through https://github.com/owner/repo/pull/42', mockModel);
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(lm.invokeTool).toHaveBeenCalledWith(
        'devdocket-readFile',
        expect.objectContaining({ input: { worktreePath: '/mock', filePath: 'src/index.ts' } }),
        token,
      );
      expect(mockModel.sendRequest).toHaveBeenCalledTimes(2);
      expect(response.markdown).toHaveBeenCalledWith('File contents analyzed.');
    });

    it('signalPhase with lastFile updates ChatResult metadata', async () => {
      const mockModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Last file analysis.');
            yield new LanguageModelToolCallPart('phase-2', 'devdocket-signalPhase', { phase: 'lastFile' });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through https://github.com/owner/repo/pull/42', mockModel);
      const context = createMockContext([new ChatRequestTurn('previous turn')]);
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      const result = await handler(request, context, response, token);

      expect(lm.invokeTool).not.toHaveBeenCalled();
      expect(mockModel.sendRequest).toHaveBeenCalledTimes(1);
      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('lastFile');
    });

    it('signalPhase updates ChatResult metadata without triggering another loop', async () => {
      const mockModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Wrap-up complete.');
            yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', { phase: 'wrapup' });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through https://github.com/owner/repo/pull/42', mockModel);
      const context = createMockContext([new ChatRequestTurn('previous turn')]);
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      const result = await handler(request, context, response, token);

      // signalPhase should not trigger invokeTool
      expect(lm.invokeTool).not.toHaveBeenCalled();
      // Model should only be called once (no re-loop for signalPhase)
      expect(mockModel.sendRequest).toHaveBeenCalledTimes(1);
      // Phase should be in the result metadata
      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('wrapup');
    });
  });

  describe('provideFollowups', () => {
    function getFollowupProvider() {
      participant.register();
      const mockParticipant = vi.mocked(chat.createChatParticipant).mock.results[0].value;
      return mockParticipant.followupProvider as {
        provideFollowups: (
          result: { metadata?: Record<string, unknown> },
          context: unknown,
          token: unknown,
        ) => { prompt: string; label: string }[];
      };
    }

    it('returns Start/Adjust/Skip buttons for summary phase', () => {
      const provider = getFollowupProvider();
      const followups = provider.provideFollowups(
        { metadata: { phase: 'summary' } },
        { history: [] },
        { isCancellationRequested: false },
      );

      expect(followups).toHaveLength(3);
      expect(followups[0].label).toContain('Start walkthrough');
      expect(followups[1].label).toContain('Adjust order');
      expect(followups[2].label).toContain('Skip to wrap-up');
    });

    it('returns Go deeper/Wrap up buttons for lastFile phase', () => {
      const provider = getFollowupProvider();
      const followups = provider.provideFollowups(
        { metadata: { phase: 'lastFile' } },
        { history: [] },
        { isCancellationRequested: false },
      );

      expect(followups).toHaveLength(2);
      expect(followups[0].label).toContain('Go deeper');
      expect(followups[1].label).toContain('Wrap up');
    });

    it('returns Next file/Go deeper/Wrap up buttons for walkthrough phase', () => {
      const provider = getFollowupProvider();
      const followups = provider.provideFollowups(
        { metadata: { phase: 'walkthrough' } },
        { history: [] },
        { isCancellationRequested: false },
      );

      expect(followups).toHaveLength(3);
      expect(followups[0].label).toContain('Next file');
      expect(followups[1].label).toContain('Go deeper');
      expect(followups[2].label).toContain('Wrap up');
    });

    it('returns empty array for wrapup phase', () => {
      const provider = getFollowupProvider();
      const followups = provider.provideFollowups(
        { metadata: { phase: 'wrapup' } },
        { history: [] },
        { isCancellationRequested: false },
      );

      expect(followups).toEqual([]);
    });

    it('returns empty array for error phase', () => {
      const provider = getFollowupProvider();
      const followups = provider.provideFollowups(
        { metadata: { phase: 'error' } },
        { history: [] },
        { isCancellationRequested: false },
      );

      expect(followups).toEqual([]);
    });

    it('returns empty array for no-url phase', () => {
      const provider = getFollowupProvider();
      const followups = provider.provideFollowups(
        { metadata: { phase: 'no-url' } },
        { history: [] },
        { isCancellationRequested: false },
      );

      expect(followups).toEqual([]);
    });
  });
});
