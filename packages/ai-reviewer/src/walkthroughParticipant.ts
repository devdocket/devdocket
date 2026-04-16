import * as vscode from 'vscode';
import { RepoManager, type WorktreeInfo } from './repoManager';
import { buildWalkthroughPrompt } from './walkthroughPrompt';

export class WalkthroughParticipant {
  private sessions = new Map<string, WorktreeInfo>();

  constructor(
    private readonly repoManager: RepoManager,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Register the chat participant. Returns disposable. */
  register(): vscode.Disposable {
    this.log.info('Creating @walkthrough chat participant');
    const participant = vscode.chat.createChatParticipant(
      'devdocket.walkthrough',
      this.handleRequest.bind(this),
    );
    participant.iconPath = new vscode.ThemeIcon('book');
    participant.followupProvider = {
      provideFollowups: this.provideFollowups.bind(this),
    };
    this.log.info('@walkthrough chat participant created successfully');
    return participant;
  }

  private provideFollowups(
    result: vscode.ChatResult,
    _context: vscode.ChatContext,
    _token: vscode.CancellationToken,
  ): vscode.ChatFollowup[] {
    const phase = (result.metadata as Record<string, unknown> | undefined)?.phase as string | undefined;

    if (phase === 'no-url' || phase === 'error' || phase === 'wrapup') {
      return [];
    }

    if (phase === 'summary') {
      return [
        { prompt: 'Start the walkthrough', label: '▶️ Start walkthrough' },
        { prompt: 'Adjust the reading order', label: '🔄 Adjust order' },
        { prompt: 'Skip to the wrap-up summary', label: '⏭️ Skip to wrap-up' },
      ];
    }

    if (phase === 'lastFile') {
      return [
        { prompt: 'Go deeper — show callers and related code', label: '🔍 Go deeper' },
        { prompt: 'Wrap up — show the final summary', label: '✅ Wrap up' },
      ];
    }

    // During file-by-file walkthrough (default)
    return [
      { prompt: 'Continue to the next file', label: '▶️ Next file' },
      { prompt: 'Go deeper — show callers and related code', label: '🔍 Go deeper' },
      { prompt: 'Skip to the wrap-up summary', label: '⏭️ Wrap up' },
    ];
  }

  /** The ChatRequestHandler. */
  private async handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> {
    this.log.debug(`handleRequest called — prompt: "${request.prompt}", history turns: ${context.history.length}`);

    // Parse PR URL from the prompt
    const prUrl = this.extractPrUrl(request.prompt, context);
    if (!prUrl) {
      this.log.warn('No PR URL found in prompt or history');
      response.markdown(
        'Please provide a GitHub PR URL to walk through. For example:\n\n' +
        '> Walk me through this PR: https://github.com/owner/repo/pull/42',
      );
      return { metadata: { phase: 'no-url' } };
    }
    this.log.debug(`Extracted PR URL: ${prUrl}`);

    // Ensure worktree
    let info = this.sessions.get(prUrl) ?? this.repoManager.getWorktreeInfo(prUrl);
    if (!info) {
      this.log.info('No cached worktree info — preparing worktree');
      response.progress('Cloning repository and preparing worktree…');
      try {
        info = await this.repoManager.ensureWorktree(prUrl);
        this.log.debug(`Worktree ready at ${info.worktreePath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`Worktree preparation failed: ${msg}`);
        response.markdown(`❌ Failed to prepare repository: ${msg}`);
        return { metadata: { phase: 'error' } };
      }
    } else {
      this.log.debug(`Using cached worktree at ${info.worktreePath}`);
    }
    this.sessions.set(prUrl, info);

    if (token.isCancellationRequested) {
      this.log.info('Request cancelled before model invocation');
      return { metadata: { phase: 'error' } };
    }

    // Build system prompt
    const systemPrompt = buildWalkthroughPrompt(info);
    this.log.debug(`System prompt length: ${systemPrompt.length} chars`);

    // Build messages array
    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
    ];

    // Add history from previous turns
    for (const turn of context.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const parts: string[] = [];
        for (const part of turn.response) {
          if (part instanceof vscode.ChatResponseMarkdownPart) {
            parts.push(part.value.value);
          }
        }
        if (parts.length > 0) {
          messages.push(vscode.LanguageModelChatMessage.Assistant(parts.join('')));
        }
      }
    }

    // Add current user message
    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
    this.log.info(`Built message array: ${messages.length} messages (1 system + ${messages.length - 2} history + 1 user)`);

    // Select model
    let model: vscode.LanguageModelChat;
    if (request.model) {
      this.log.info(`Using request-provided model: ${request.model.id}`);
      model = request.model;
    } else {
      this.log.info('No request model — selecting gpt-4o family');
      const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
      this.log.info(`selectChatModels({ family: 'gpt-4o' }) returned ${models.length} model(s): ${models.map(m => m.id).join(', ')}`);
      if (models.length === 0) {
        this.log.error('No language model available');
        response.markdown('❌ No language model available. Please install GitHub Copilot.');
        return { metadata: { phase: 'error' } };
      }
      model = models[0];
    }
    this.log.info(`Selected model: ${model.id} (vendor: ${model.vendor}, family: ${model.family})`);

    // Gather devdocket tools + the phase-signaling tool
    const registeredTools = vscode.lm.tools
      .filter((t: vscode.LanguageModelToolInformation) => t.name.startsWith('devdocket-') && t.inputSchema);
    this.log.info(`Found ${registeredTools.length} devdocket-* LM tools: ${registeredTools.map(t => t.name).join(', ')}`);

    const tools = [
      ...registeredTools
        .map((t: vscode.LanguageModelToolInformation) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        })),
      {
        name: 'devdocket-signalPhase',
        description: 'Signal the current walkthrough phase so the UI can show appropriate follow-up actions. Call this at the end of every response.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            phase: {
              type: 'string' as const,
              enum: ['summary', 'walkthrough', 'lastFile', 'wrapup'],
              description: 'Current phase: "summary" after presenting the opening overview, "walkthrough" during file-by-file presentation, "lastFile" when presenting the last file in the reading order, "wrapup" after the final wrap-up.',
            },
          },
          required: ['phase'],
        },
      },
    ];
    this.log.info(`Total tools passed to model: ${tools.length} (${tools.map(t => t.name).join(', ')})`);

    // Tool-use loop
    const loopMessages = [...messages];
    const maxIterations = 20;
    let iterations = 0;
    let phase = context.history.length === 0 ? 'summary' : 'walkthrough';
    this.log.info(`Starting tool-use loop — initial phase: ${phase}, maxIterations: ${maxIterations}`);

    while (!token.isCancellationRequested && iterations < maxIterations) {
      iterations++;
      this.log.debug(`Tool-use loop iteration ${iterations} — sending ${loopMessages.length} messages to model`);

      let chatResponse: vscode.LanguageModelChatResponse;
      try {
        chatResponse = await model.sendRequest(loopMessages, { tools }, token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`model.sendRequest failed on iteration ${iterations}: ${msg}`);
        response.markdown(`\n\n❌ Model request failed: ${msg}`);
        return { metadata: { phase: 'error' } };
      }

      let hasToolCalls = false;
      const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
      const toolResults: Array<{ callId: string; content: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] }> = [];

      for await (const part of chatResponse.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          response.markdown(part.value);
          assistantParts.push(part);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          assistantParts.push(part);

          // Handle phase signal locally — not a real tool call, don't trigger another loop
          if (part.name === 'devdocket-signalPhase') {
            const input = part.input as { phase?: string };
            this.log.info(`Phase signal: ${input.phase}`);
            if (input.phase) {
              phase = input.phase;
            }
            toolResults.push({
              callId: part.callId,
              content: [new vscode.LanguageModelTextPart('Phase recorded.')],
            });
            continue;
          }

          hasToolCalls = true;
          this.log.debug(`Tool call: ${part.name} (callId: ${part.callId})`);
          try {
            this.log.debug(`Tool input: ${JSON.stringify(part.input)}`);
          } catch {
            this.log.debug(`Tool input: [unserializable]`);
          }
          try {
            const result = await vscode.lm.invokeTool(
              part.name,
              {
                input: part.input,
                toolInvocationToken: request.toolInvocationToken,
              },
              token,
            );
            this.log.debug(`Tool ${part.name} completed successfully`);
            toolResults.push({ callId: part.callId, content: result.content });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.log.error(`Tool ${part.name} failed: ${errMsg}`);
            toolResults.push({
              callId: part.callId,
              content: [new vscode.LanguageModelTextPart(`Error: ${errMsg}`)],
            });
          }
        }
      }

      this.log.debug(`Iteration ${iterations} complete — ${assistantParts.length} parts, ${toolResults.length} tool results, hasToolCalls: ${hasToolCalls}`);

      // Add the complete assistant turn + all tool results to conversation
      if (assistantParts.length > 0) {
        loopMessages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
        for (const tr of toolResults) {
          loopMessages.push(
            vscode.LanguageModelChatMessage.User([
              new vscode.LanguageModelToolResultPart(tr.callId, tr.content),
            ]),
          );
        }
      }

      if (!hasToolCalls) {
        this.log.info(`No tool calls in iteration ${iterations} — exiting loop`);
        break;
      }
    }

    if (token.isCancellationRequested) {
      this.log.info('Request cancelled during tool-use loop');
    }
    if (iterations >= maxIterations) {
      this.log.warn(`Reached max iterations (${maxIterations})`);
    }
    this.log.info(`handleRequest complete — final phase: ${phase}, total iterations: ${iterations}`);
    return { metadata: { phase } };
  }

  private extractPrUrl(
    prompt: string,
    context: vscode.ChatContext,
  ): string | undefined {
    // Try current prompt first
    const urlMatch = prompt.match(
      /https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/,
    );
    if (urlMatch) return urlMatch[0];

    // Check previous turns in history
    for (const turn of context.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        const historyMatch = turn.prompt.match(
          /https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/,
        );
        if (historyMatch) return historyMatch[0];
      }
    }

    return undefined;
  }
}
