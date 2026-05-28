import { describe, it, expect, beforeEach, vi } from 'vitest';
import { chat, lm, LanguageModelTextPart, LanguageModelToolCallPart, ChatRequestTurn, mockLogOutputChannel } from 'vscode';
import { WalkthroughParticipant } from '../walkthroughParticipant';
import type { RepoManager } from '../repoManager';
import { gitExec } from '../tools/gitUtils';
import { createMockRepoManager } from './testFactories';

vi.mock('../tools/gitUtils', () => ({
  gitExec: vi.fn(),
}));

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
    vi.mocked(gitExec).mockResolvedValue('src/first.ts\nsrc/second.ts\n');
    lm.tools = [];
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
        expect.stringContaining('Please provide a GitHub or Azure DevOps PR URL'),
      );
    });

    it('calls repoManager.ensureWorktree for GitHub PR URL in prompt', async () => {
      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through this PR: https://github.com/owner/repo/pull/42');
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(mockRepoManager.ensureWorktree).toHaveBeenCalledWith(
        'https://github.com/owner/repo/pull/42',
        expect.anything(),
      );
    });

    it('calls repoManager.ensureWorktree for Azure DevOps PR URL in prompt', async () => {
      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through this PR: https://dev.azure.com/org/project/_git/repo/pullrequest/42');
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(mockRepoManager.ensureWorktree).toHaveBeenCalledWith(
        'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
        expect.anything(),
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

    it('does not derive progress or call the model when cancelled before model invocation', async () => {
      const mockModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Should not stream.');
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const result = await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', mockModel),
        createMockContext(),
        createMockResponse(),
        { isCancellationRequested: true },
      );

      expect(gitExec).not.toHaveBeenCalled();
      expect(mockModel.sendRequest).not.toHaveBeenCalled();
      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('error');
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
        expect.anything(),
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

    it('does not pass GitHub diff-anchor tool to the model for Azure DevOps PRs', async () => {
      lm.tools = [
        { name: 'devdocket-readFile', description: 'Read', inputSchema: { type: 'object' } },
        { name: 'devdocket-diffAnchor', description: 'Anchor', inputSchema: { type: 'object' } },
      ];
      const mockModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('ADO walkthrough.');
          })(),
        }),
      };
      vi.mocked(mockRepoManager.ensureWorktree).mockResolvedValue({
        worktreePath: '/mock/worktrees/pr-42',
        clonePath: '/mock/repos/ado-org-project-repo/clone',
        org: 'org/project',
        repo: 'repo',
        prNumber: '42',
        headRef: 'refs/devdocket/ado/pr-42-head',
        baseRef: 'refs/devdocket/ado/pr-42-base',
        prUrl: 'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
        provider: 'ado',
      });

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through https://dev.azure.com/org/project/_git/repo/pullrequest/42', mockModel);
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      const tools = mockModel.sendRequest.mock.calls[0][1].tools as Array<{ name: string }>;
      expect(tools.some(tool => tool.name === 'devdocket-readFile')).toBe(true);
      expect(tools.some(tool => tool.name === 'devdocket-diffAnchor')).toBe(false);
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

    it('continues when a model emits only signalPhase before walkthrough text', async () => {
      const mockModel = {
        sendRequest: vi.fn()
          .mockResolvedValueOnce({
            stream: (async function* () {
              yield new LanguageModelTextPart('\n');
              yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', { phase: 'summary' });
            })(),
          })
          .mockResolvedValueOnce({
            stream: (async function* () {
              yield new LanguageModelTextPart('Summary after phase acknowledgement.');
            })(),
          }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through https://github.com/owner/repo/pull/42', mockModel);
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      const result = await handler(request, context, response, token);

      expect(lm.invokeTool).not.toHaveBeenCalled();
      expect(mockModel.sendRequest).toHaveBeenCalledTimes(2);
      expect(response.markdown).toHaveBeenCalledWith('Summary after phase acknowledgement.');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('summary');
    });

    it('stops retrying after repeated phase-only responses without walkthrough text', async () => {
      const mockModel = {
        sendRequest: vi.fn().mockImplementation(() => ({
          stream: (async function* () {
            yield new LanguageModelTextPart('\n');
            yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', { phase: 'summary' });
          })(),
        })),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through https://github.com/owner/repo/pull/42', mockModel);
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(lm.invokeTool).not.toHaveBeenCalled();
      expect(mockModel.sendRequest).toHaveBeenCalledTimes(2);
      expect(response.markdown).toHaveBeenCalledWith(
        '⚠️ The model did not produce walkthrough text. Please try again.',
      );
    });

    it('warns when the model finishes without visible walkthrough text', async () => {
      const mockModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('\n  \t');
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const request = createMockRequest('Walk me through https://github.com/owner/repo/pull/42', mockModel);
      const context = createMockContext();
      const response = createMockResponse();
      const token = { isCancellationRequested: false };

      await handler(request, context, response, token);

      expect(mockModel.sendRequest).toHaveBeenCalledTimes(1);
      expect(response.markdown).toHaveBeenCalledWith('\n  \t');
      expect(response.markdown).toHaveBeenCalledWith(
        '⚠️ The model did not produce walkthrough text. Please try again.',
      );
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

    it('overrides walkthrough phase to lastFile when signalPhase reports the final file', async () => {
      const firstFileModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('First file analysis.');
            yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: '"./src/first.ts"',
            });
          })(),
        }),
      };
      const lastFileModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Second file analysis.');
            yield new LanguageModelToolCallPart('phase-2', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePaths: ['`b\\src\\second.ts`'],
            });
          })(),
        }),
      };

      participant.register();
      const mockParticipant = vi.mocked(chat.createChatParticipant).mock.results[0].value;
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const provider = mockParticipant.followupProvider as {
        provideFollowups: (
          result: { metadata?: Record<string, unknown> },
          context: unknown,
          token: unknown,
        ) => { prompt: string; label: string }[];
      };
      const token = { isCancellationRequested: false };

      const firstResult = await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', firstFileModel),
        createMockContext(),
        createMockResponse(),
        token,
      );
      const firstFollowups = provider.provideFollowups(
        firstResult as { metadata?: Record<string, unknown> },
        { history: [] },
        token,
      );

      expect((firstResult as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((firstResult as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);
      expect(firstFollowups.map(followup => followup.label).join(' ')).toContain('Next file');

      const lastResult = await handler(
        createMockRequest('Continue', lastFileModel),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        token,
      );
      const lastFollowups = provider.provideFollowups(
        lastResult as { metadata?: Record<string, unknown> },
        { history: [] },
        token,
      );

      expect((lastResult as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('lastFile');
      expect((lastResult as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(0);
      expect(lastFollowups).toHaveLength(2);
      expect(lastFollowups[0].label).toContain('Go deeper');
      expect(lastFollowups[1].label).toContain('Wrap up');
      expect(lastFollowups.map(followup => followup.label).join(' ')).not.toContain('Next file');
    });

    it('overrides walkthrough phase to lastFile when signalPhase reports the final file group', async () => {
      const mockModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Grouped final file analysis.');
            yield new LanguageModelToolCallPart('phase-group', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePaths: ['src/first.ts', 'src/second.ts'],
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const result = await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', mockModel),
        createMockContext(),
        createMockResponse(),
        { isCancellationRequested: false },
      );

      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('lastFile');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(0);
    });

    it('accounts for unmatched paths in partially matched final file groups', async () => {
      const mockModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Grouped final file analysis with a malformed path.');
            yield new LanguageModelToolCallPart('phase-partial-group', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePaths: ['src/first.ts', 'not-in-diff.ts'],
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const result = await handler(
        createMockRequest('Start the walkthrough', mockModel),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        { isCancellationRequested: false },
      );

      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('lastFile');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.presentedFiles).toEqual(['src/first.ts']);
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(0);
    });

    it('does not record file paths from summary phase signals', async () => {
      const mockModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Summary with reading order.');
            yield new LanguageModelToolCallPart('phase-summary', 'devdocket-signalPhase', {
              phase: 'summary',
              filePaths: ['src/first.ts', 'src/second.ts'],
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const result = await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', mockModel),
        createMockContext(),
        createMockResponse(),
        { isCancellationRequested: false },
      );

      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('summary');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.presentedFiles).toEqual([]);
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(2);
    });

    it('ignores non-string file path values in signalPhase input', async () => {
      const mockModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Malformed phase input should not abort.');
            yield new LanguageModelToolCallPart('phase-malformed', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: null,
              filePaths: ['src/first.ts', null, 42],
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const result = await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', mockModel),
        createMockContext(),
        createMockResponse(),
        { isCancellationRequested: false },
      );

      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.presentedFiles).toEqual(['src/first.ts']);
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);
    });

    it('advances remaining-file count when signalPhase omits filePath entirely', async () => {
      // Two walkthrough phase signals with no filePath/filePaths at all.
      // Each should still count as one presentation so the second turn
      // reaches remainingFiles=0 and the phase derives to lastFile.
      const firstModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('First file analysis.');
            yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', {
              phase: 'walkthrough',
            });
          })(),
        }),
      };
      const secondModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Second file analysis.');
            yield new LanguageModelToolCallPart('phase-2', 'devdocket-signalPhase', {
              phase: 'walkthrough',
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const token = { isCancellationRequested: false };

      const firstResult = await handler(
        createMockRequest('Start the walkthrough', firstModel),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        token,
      );
      expect((firstResult as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((firstResult as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);

      const secondResult = await handler(
        createMockRequest('Continue', secondModel),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        token,
      );
      expect((secondResult as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('lastFile');
      expect((secondResult as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(0);
    });

    it('advances remaining-file count when signalPhase paths cannot be matched to allFiles', async () => {
      // Model passes paths that don't normalize to anything in allFiles
      // (e.g. absolute paths or fabricated names). Each unmatched walkthrough
      // signal should still count as a presentation so the loop converges.
      const mismatchedFirst = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Mismatched path file 1.');
            yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: '/abs/path/not/in/diff.ts',
            });
          })(),
        }),
      };
      const mismatchedSecond = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Mismatched path file 2.');
            yield new LanguageModelToolCallPart('phase-2', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePaths: ['totally-unknown.ts', 'also-unknown.ts'],
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const token = { isCancellationRequested: false };

      const firstResult = await handler(
        createMockRequest('Start the walkthrough', mismatchedFirst),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        token,
      );
      // Path didn't match allFiles, so presentedFiles stays empty, but the
      // unidentified-presentations counter advances the remaining count.
      expect((firstResult as { metadata?: Record<string, unknown> }).metadata?.presentedFiles).toEqual([]);
      expect((firstResult as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);

      const secondResult = await handler(
        createMockRequest('Continue', mismatchedSecond),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        token,
      );
      expect((secondResult as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('lastFile');
      expect((secondResult as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(0);
    });

    it('canonicalizes a bare basename in signalPhase to a uniquely matching file', async () => {
      // Model passes just the basename, not the full path. As long as the
      // basename is unique within allFiles it should be matched and counted
      // as an identified presentation.
      const model = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Bare basename presentation.');
            yield new LanguageModelToolCallPart('phase-basename', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: 'second.ts',
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const result = await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', model),
        createMockContext([new ChatRequestTurn('previous turn')]),
        createMockResponse(),
        { isCancellationRequested: false },
      );

      expect((result as { metadata?: Record<string, unknown> }).metadata?.presentedFiles).toEqual(['src/second.ts']);
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);
    });

    it('does not match ambiguous basenames in signalPhase', async () => {
      // Two files share the same basename — basename-only signal must be
      // treated as unidentified (not matched to either candidate).
      vi.mocked(gitExec).mockResolvedValueOnce('src/a/index.ts\nsrc/b/index.ts\n');
      const model = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Ambiguous basename presentation.');
            yield new LanguageModelToolCallPart('phase-ambig', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: 'index.ts',
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const result = await handler(
        createMockRequest('Continue to the next file', model),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        { isCancellationRequested: false },
      );

      // Not added to presentedFiles (would be wrong to pick one arbitrarily),
      // but counted as an unidentified presentation so progress still advances.
      expect((result as { metadata?: Record<string, unknown> }).metadata?.presentedFiles).toEqual([]);
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);
    });

    it('does not advance unidentified progress for phase-only retry iterations', async () => {
      const mockModel = {
        sendRequest: vi.fn()
          .mockResolvedValueOnce({
            stream: (async function* () {
              yield new LanguageModelToolCallPart('phase-only', 'devdocket-signalPhase', {
                phase: 'walkthrough',
              });
            })(),
          })
          .mockResolvedValueOnce({
            stream: (async function* () {
              yield new LanguageModelTextPart('First file analysis after retry.');
              yield new LanguageModelToolCallPart('phase-text', 'devdocket-signalPhase', {
                phase: 'walkthrough',
                filePath: 'src/first.ts',
              });
            })(),
          }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const result = await handler(
        createMockRequest('Start the walkthrough', mockModel),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        { isCancellationRequested: false },
      );

      expect(mockModel.sendRequest).toHaveBeenCalledTimes(2);
      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.presentedFiles).toEqual(['src/first.ts']);
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);
    });

    it('does not advance unidentified progress for free-form prompts that mention next-file wording', async () => {
      const firstFileModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('First file analysis.');
            yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: 'src/first.ts',
            });
          })(),
        }),
      };
      const clarificationModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Clarifying before moving on.');
            yield new LanguageModelToolCallPart('phase-clarify', 'devdocket-signalPhase', {
              phase: 'walkthrough',
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const token = { isCancellationRequested: false };

      await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', firstFileModel),
        createMockContext(),
        createMockResponse(),
        token,
      );

      const result = await handler(
        createMockRequest('Can you explain this before we continue to the next file?', clarificationModel),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        token,
      );

      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);
    });

    it('does not advance unidentified progress for non-advancing follow-ups', async () => {
      const firstFileModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('First file analysis.');
            yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: 'src/first.ts',
            });
          })(),
        }),
      };
      const deeperModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('More detail about the first file.');
            yield new LanguageModelToolCallPart('phase-deeper', 'devdocket-signalPhase', {
              phase: 'walkthrough',
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const token = { isCancellationRequested: false };

      await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', firstFileModel),
        createMockContext(),
        createMockResponse(),
        token,
      );

      const deeperResult = await handler(
        createMockRequest('Go deeper — show callers and related code', deeperModel),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        token,
      );

      expect((deeperResult as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((deeperResult as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);
    });

    it('combines signaled and advance-prompt progress via max so a model that signals once and then stops still advances', async () => {
      // 3-file PR. Turn 1 signals the first file via signalPhase. Turns 2-3 are
      // deterministic "Continue to the next file" prompts where the model
      // emits only text (no signalPhase call). The advance-prompt counter
      // must continue to credit progress; otherwise `signaledPresented = 1`
      // would lock `totalPresented` at 1 forever and "Next file" would
      // persist on the final file.
      vi.mocked(gitExec).mockResolvedValue('src/first.ts\nsrc/second.ts\nsrc/third.ts');

      const signalingFirstModel = {
        sendRequest: vi.fn().mockImplementation(() => ({
          stream: (async function* () {
            yield new LanguageModelTextPart('First file analysis.');
            yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: 'src/first.ts',
            });
          })(),
        })),
      };
      const silentModel = {
        sendRequest: vi.fn().mockImplementation(() => ({
          stream: (async function* () {
            yield new LanguageModelTextPart('Next file analysis (model does not call signalPhase).');
          })(),
        })),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const token = { isCancellationRequested: false };

      // Turn 1: Start prompt → model signals first file.
      await handler(
        createMockRequest('Start the walkthrough', signalingFirstModel),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        token,
      );

      // Turn 2: Continue → model emits only text, no signalPhase. Should still
      // advance via the deterministic prompt counter, so remainingFiles drops
      // from 2 to 1.
      const turn2 = await handler(
        createMockRequest('Continue to the next file', silentModel),
        createMockContext([
          new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42'),
          new ChatRequestTurn('Start the walkthrough'),
        ]),
        createMockResponse(),
        token,
      );
      expect((turn2 as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((turn2 as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);

      // Turn 3: Continue → final file. Advance counter reaches 3, equal to
      // allFiles.length, so remainingFiles must be 0 and the phase must be
      // upgraded to lastFile.
      const turn3 = await handler(
        createMockRequest('Continue to the next file', silentModel),
        createMockContext([
          new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42'),
          new ChatRequestTurn('Start the walkthrough'),
          new ChatRequestTurn('Continue to the next file'),
        ]),
        createMockResponse(),
        token,
      );
      expect((turn3 as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('lastFile');
      expect((turn3 as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(0);
    });

    it('reconciles an unidentified presentation when the same file is later identified', async () => {
      // 2-file PR. Turn 1 records a presentation without filePath
      // (unidentifiedPresentations += 1). Turn 2 is a non-advancing
      // follow-up that DOES include a filePath for the same first file.
      // Without reconciliation, signaledPresented = 1 (presentedFiles) +
      // 1 (unidentifiedPresentations) = 2 == allFiles.length, so
      // remainingFiles would prematurely collapse to 0 before the second
      // file is shown. The reconciliation must keep remainingFiles at 1.
      vi.mocked(gitExec).mockResolvedValue('src/first.ts\nsrc/second.ts');

      const unidentifiedFirstModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('First file analysis (no filePath signaled).');
            yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', {
              phase: 'walkthrough',
            });
          })(),
        }),
      };
      const deeperWithPathModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Deeper look at the first file, now with the path.');
            yield new LanguageModelToolCallPart('phase-deeper', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: 'src/first.ts',
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const token = { isCancellationRequested: false };

      await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', unidentifiedFirstModel),
        createMockContext(),
        createMockResponse(),
        token,
      );

      const deeperResult = await handler(
        createMockRequest('Go deeper — show callers and related code', deeperWithPathModel),
        createMockContext([
          new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42'),
        ]),
        createMockResponse(),
        token,
      );

      expect((deeperResult as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((deeperResult as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);
      expect((deeperResult as { metadata?: Record<string, unknown> }).metadata?.presentedFiles).toEqual(['src/first.ts']);
    });

    it('does not reconcile unidentified progress during later advancing file groups', async () => {
      vi.mocked(gitExec).mockResolvedValue('src/first.ts\nsrc/second.ts\nsrc/third.ts');
      const unidentifiedFirstModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('First file analysis without a path.');
            yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', {
              phase: 'walkthrough',
            });
          })(),
        }),
      };
      const finalGroupModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Final grouped file analysis.');
            yield new LanguageModelToolCallPart('phase-group', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePaths: ['src/second.ts', 'src/third.ts'],
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const token = { isCancellationRequested: false };

      await handler(
        createMockRequest('Start the walkthrough', unidentifiedFirstModel),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        token,
      );

      const result = await handler(
        createMockRequest('Continue to the next file', finalGroupModel),
        createMockContext([
          new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42'),
          new ChatRequestTurn('Start the walkthrough'),
        ]),
        createMockResponse(),
        token,
      );

      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('lastFile');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(0);
      expect((result as { metadata?: Record<string, unknown> }).metadata?.presentedFiles).toEqual(['src/second.ts', 'src/third.ts']);
    });

    it('resets file progress when a fresh chat starts for the same PR', async () => {
      const firstFileModel = {
        sendRequest: vi.fn().mockImplementation(() => ({
          stream: (async function* () {
            yield new LanguageModelTextPart('First file analysis.');
            yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: 'src/first.ts',
            });
          })(),
        })),
      };
      const lastFileModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Second file analysis.');
            yield new LanguageModelToolCallPart('phase-2', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: 'src/second.ts',
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const token = { isCancellationRequested: false };

      await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', firstFileModel),
        createMockContext(),
        createMockResponse(),
        token,
      );
      await handler(
        createMockRequest('Continue', lastFileModel),
        createMockContext([new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42')]),
        createMockResponse(),
        token,
      );

      const freshResult = await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', firstFileModel),
        createMockContext(),
        createMockResponse(),
        token,
      );

      expect((freshResult as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((freshResult as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);
    });

    it('derives lastFile from advance-prompt count when the model never calls signalPhase (3-file PR, real-world Claude Opus 4.7 trace)', async () => {
      // Reproduces the user-reported bug: 3-file PR, model writes walkthrough
      // prose for each file but never invokes devdocket-signalPhase. We rely on
      // counting deterministic followup-button prompts ("Start the walkthrough",
      // "Continue to the next file") to estimate how many files have been
      // presented, independently of whether the model cooperates.
      vi.mocked(gitExec).mockResolvedValue('src/a.ts\nsrc/b.ts\nsrc/c.ts\n');
      const silentModel = {
        sendRequest: vi.fn().mockImplementation(() => ({
          stream: (async function* () {
            yield new LanguageModelTextPart('Walking through a file. No phase signal.');
          })(),
        })),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const token = { isCancellationRequested: false };

      // Turn 1: initial summary request.
      await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', silentModel),
        createMockContext(),
        createMockResponse(),
        token,
      );

      // Turn 2: user clicks "Start the walkthrough" → file 1 of 3.
      const turn2 = await handler(
        createMockRequest('Start the walkthrough', silentModel),
        createMockContext([
          new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42'),
        ]),
        createMockResponse(),
        token,
      );
      expect((turn2 as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((turn2 as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(2);

      // Turn 3: "Continue to the next file" → file 2 of 3.
      const turn3 = await handler(
        createMockRequest('Continue to the next file', silentModel),
        createMockContext([
          new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42'),
          new ChatRequestTurn('Start the walkthrough'),
        ]),
        createMockResponse(),
        token,
      );
      expect((turn3 as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((turn3 as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);

      // Turn 4: "Continue to the next file" → file 3 of 3 → should derive lastFile
      // and surface the "Wrap up" follow-ups instead of yet another "Next file".
      const turn4 = await handler(
        createMockRequest('Continue to the next file', silentModel),
        createMockContext([
          new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42'),
          new ChatRequestTurn('Start the walkthrough'),
          new ChatRequestTurn('Continue to the next file'),
        ]),
        createMockResponse(),
        token,
      );
      expect((turn4 as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('lastFile');
      expect((turn4 as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(0);
    });

    it('does not count "Go deeper" or "Adjust the reading order" as advance prompts', async () => {
      // Non-advance prompts must not bump the advance counter, otherwise we'd
      // race past the actual last file. allFiles = 2, only 1 real advance
      // ("Start the walkthrough") → remaining must stay at 1, not collapse to 0.
      const silentModel = {
        sendRequest: vi.fn().mockImplementation(() => ({
          stream: (async function* () {
            yield new LanguageModelTextPart('Some commentary.');
          })(),
        })),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const token = { isCancellationRequested: false };

      // Pre-build context as if the user has already started the walkthrough
      // (turn 1: PR URL, turn 2: Start) and now clicks "Go deeper".
      const result = await handler(
        createMockRequest('Go deeper — show callers and related code', silentModel),
        createMockContext([
          new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42'),
          new ChatRequestTurn('Start the walkthrough'),
        ]),
        createMockResponse(),
        token,
      );

      // Advance prompts seen: only "Start the walkthrough" (counted) — the
      // current "Go deeper" prompt is non-advance and the URL prompt is also
      // non-advance. So advanceCount = 1, remaining = 2 - 1 = 1.
      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);
    });

    it('combines signaled progress with deterministic advance prompts', async () => {
      const firstModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('First file analysis.');
            yield new LanguageModelToolCallPart('phase-1', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: 'src/first.ts',
            });
          })(),
        }),
      };
      const silentModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Second file analysis without phase signal.');
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const token = { isCancellationRequested: false };

      await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', firstModel),
        createMockContext(),
        createMockResponse(),
        token,
      );

      const result = await handler(
        createMockRequest('Continue to the next file', silentModel),
        createMockContext([
          new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42'),
          new ChatRequestTurn('Start the walkthrough'),
        ]),
        createMockResponse(),
        token,
      );

      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('lastFile');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(0);
    });

    it('does not count free-form clarification prompts as advance prompts', async () => {
      const silentModel = {
        sendRequest: vi.fn().mockImplementation(() => ({
          stream: (async function* () {
            yield new LanguageModelTextPart('Clarifying detail without moving files.');
          })(),
        })),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const result = await handler(
        createMockRequest('Why was this helper changed?', silentModel),
        createMockContext([
          new ChatRequestTurn('Walk me through https://github.com/owner/repo/pull/42'),
          new ChatRequestTurn('Start the walkthrough'),
        ]),
        createMockResponse(),
        { isCancellationRequested: false },
      );

      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);
    });

    it('does not downgrade a model-reported lastFile phase when files appear to remain', async () => {
      const mockModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('Model says this is the final file.');
            yield new LanguageModelToolCallPart('phase-last', 'devdocket-signalPhase', {
              phase: 'lastFile',
              filePath: 'src/first.ts',
            });
          })(),
        }),
      };

      participant.register();
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];

      const result = await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', mockModel),
        createMockContext([new ChatRequestTurn('previous turn')]),
        createMockResponse(),
        { isCancellationRequested: false },
      );

      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('lastFile');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBe(1);
    });

    it('falls back to normal walkthrough followups when the changed-file list cannot be derived', async () => {
      vi.mocked(gitExec).mockRejectedValueOnce(new Error('missing refs'));
      const mockModel = {
        sendRequest: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield new LanguageModelTextPart('A file analysis.');
            yield new LanguageModelToolCallPart('phase-unknown', 'devdocket-signalPhase', {
              phase: 'walkthrough',
              filePath: 'src/only.ts',
            });
          })(),
        }),
      };

      participant.register();
      const mockParticipant = vi.mocked(chat.createChatParticipant).mock.results[0].value;
      const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1];
      const provider = mockParticipant.followupProvider as {
        provideFollowups: (
          result: { metadata?: Record<string, unknown> },
          context: unknown,
          token: unknown,
        ) => { prompt: string; label: string }[];
      };
      const token = { isCancellationRequested: false };

      const result = await handler(
        createMockRequest('Walk me through https://github.com/owner/repo/pull/42', mockModel),
        createMockContext(),
        createMockResponse(),
        token,
      );
      const followups = provider.provideFollowups(
        result as { metadata?: Record<string, unknown> },
        { history: [] },
        token,
      );

      expect((result as { metadata?: Record<string, unknown> }).metadata?.phase).toBe('walkthrough');
      expect((result as { metadata?: Record<string, unknown> }).metadata?.remainingFiles).toBeUndefined();
      expect(followups[0].label).toContain('Next file');
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

    it('keeps Next file for walkthrough phase while files remain', () => {
      const provider = getFollowupProvider();
      const followups = provider.provideFollowups(
        { metadata: { phase: 'walkthrough', remainingFiles: 1 } },
        { history: [] },
        { isCancellationRequested: false },
      );

      expect(followups).toHaveLength(3);
      expect(followups[0].label).toContain('Next file');
      expect(followups[1].label).toContain('Go deeper');
      expect(followups[2].label).toContain('Wrap up');
    });

    it('returns last-file buttons for walkthrough phase when no files remain', () => {
      const provider = getFollowupProvider();
      const followups = provider.provideFollowups(
        { metadata: { phase: 'walkthrough', remainingFiles: 0 } },
        { history: [] },
        { isCancellationRequested: false },
      );

      expect(followups).toHaveLength(2);
      expect(followups[0].label).toContain('Go deeper');
      expect(followups[1].label).toContain('Wrap up');
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
