import * as vscode from 'vscode';
import { RepoManager, type WorktreeInfo } from './repoManager';
import { buildWalkthroughPrompt } from './walkthroughPrompt';
import { truncateToolContent } from './toolUtils';
import { gitExec } from './tools/gitUtils';

const PR_URL_PATTERN = /https?:\/\/(?:github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+|dev\.azure\.com\/[^/\s]+\/[^/\s]+\/_git\/[^/\s]+\/pullrequest\/\d+)/;

interface WalkthroughProgress {
  allFiles: string[];
  presentedFiles: string[];
  /**
   * Count of advancing signalPhase calls with a file-walkthrough phase where
   * the model did not provide any path that we could match to a file in
   * `allFiles` (missing, malformed, or paths we couldn't canonicalize).
   */
  unidentifiedPresentations: number;
}

export class WalkthroughParticipant {
  private sessions = new Map<string, WorktreeInfo>();
  private progressByPrUrl = new Map<string, WalkthroughProgress>();

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
    const metadata = result.metadata as Record<string, unknown> | undefined;
    const phase = metadata?.phase as string | undefined;
    const remainingFiles = typeof metadata?.remainingFiles === 'number'
      ? metadata.remainingFiles
      : undefined;

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

    if (phase === 'lastFile' || (phase === 'walkthrough' && remainingFiles === 0)) {
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
        'Please provide a GitHub or Azure DevOps PR URL to walk through. For example:\n\n' +
        '> Walk me through this PR: https://github.com/owner/repo/pull/42\n\n' +
        '> Walk me through this PR: https://dev.azure.com/org/project/_git/repo/pullrequest/42',
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
        info = await this.repoManager.ensureWorktree(prUrl, token);
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

    const progress = await this.getOrCreateProgress(prUrl, info, context.history.length === 0);

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
      this.log.info('No request model — selecting default');
      const models = await vscode.lm.selectChatModels();
      this.log.info(`selectChatModels() returned ${models.length} model(s): ${models.map(m => m.id).join(', ')}`);
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
      .filter((t: vscode.LanguageModelToolInformation) =>
        t.name.startsWith('devdocket-')
        && t.inputSchema
        && !(info.provider === 'ado' && t.name === 'devdocket-diffAnchor'),
      );
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
            filePath: {
              type: 'string' as const,
              description: 'Relative path of the file just presented. Pass this for walkthrough and lastFile phases using the exact path from the diff.',
            },
            filePaths: {
              type: 'array' as const,
              items: { type: 'string' as const },
              description: 'Relative paths for every file in the group just presented. Use exact paths from the diff.',
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
    const maxPhaseOnlyRetries = 1;
    let iterations = 0;
    let phase = context.history.length === 0 ? 'summary' : 'walkthrough';
    let streamedAnyText = false;
    let phaseOnlyNoTextIterations = 0;
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
      let streamedTextThisIteration = false;
      const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
      const toolResults: Array<{ callId: string; content: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] }> = [];

      for await (const part of chatResponse.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          response.markdown(part.value);
          if (part.value.trim().length > 0) {
            streamedTextThisIteration = true;
            streamedAnyText = true;
          }
          assistantParts.push(part);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          assistantParts.push(part);

          // Handle phase signals locally; only loop again for them if no text was streamed.
          if (part.name === 'devdocket-signalPhase') {
            const input = part.input as { phase?: string; filePath?: unknown; filePaths?: unknown };
            const signaledPaths = this.getSignaledFilePaths(input);
            this.log.debug(`Phase signal: ${input.phase}${signaledPaths.length > 0 ? ` for ${signaledPaths.join(', ')}` : ''}`);
            if (input.phase) {
              phase = input.phase;
            }
            if (this.isFileWalkthroughPhase(phase)) {
              let identifiedCount = 0;
              for (const filePath of signaledPaths) {
                if (this.recordPresentedFile(progress, filePath)) {
                  identifiedCount++;
                }
              }
              // Only advance unidentified progress for prompts that move to a
              // new file. Follow-ups like "Go deeper" may re-signal the same
              // phase without presenting the next file.
              if (identifiedCount === 0 && progress.allFiles.length > 0 && this.isAdvancePrompt(request.prompt)) {
                progress.unidentifiedPresentations++;
              }
              phase = this.deriveFileWalkthroughPhase(phase, progress);
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
            toolResults.push({ callId: part.callId, content: truncateToolContent(result.content) });
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

      const phaseSignalWithoutText = !hasToolCalls && toolResults.length > 0 && !streamedTextThisIteration;
      if (phaseSignalWithoutText) {
        phaseOnlyNoTextIterations++;
      } else {
        phaseOnlyNoTextIterations = 0;
      }
      const shouldRetryForPhaseSignal = phaseSignalWithoutText && phaseOnlyNoTextIterations <= maxPhaseOnlyRetries;

      if (!hasToolCalls && !shouldRetryForPhaseSignal) {
        this.log.info(`No tool calls requiring another model request in iteration ${iterations} — exiting loop`);
        break;
      }
    }

    if (token.isCancellationRequested) {
      this.log.info('Request cancelled during tool-use loop');
    }
    if (iterations >= maxIterations) {
      this.log.warn(`Reached max iterations (${maxIterations})`);
    }
    if (!streamedAnyText && !token.isCancellationRequested) {
      response.markdown('⚠️ The model did not produce walkthrough text. Please try again.');
    }
    // Final safety net: re-derive the phase from observable progress regardless of
    // whether signalPhase fired this turn. If the model said 'walkthrough' but every
    // file has been presented (or accounted for via unidentified presentations), the
    // correct follow-up set is the lastFile one.
    if (this.isFileWalkthroughPhase(phase)) {
      phase = this.deriveFileWalkthroughPhase(phase, progress);
    }
    const remainingFiles = this.getRemainingFiles(progress);
    this.log.info(`handleRequest complete — final phase: ${phase}, total iterations: ${iterations}`);
    return {
      metadata: {
        phase,
        files: [...progress.allFiles],
        presentedFiles: [...progress.presentedFiles],
        remainingFiles,
      },
    };
  }

  private async getOrCreateProgress(
    prUrl: string,
    info: WorktreeInfo,
    resetExisting: boolean,
  ): Promise<WalkthroughProgress> {
    const existing = this.progressByPrUrl.get(prUrl);
    if (existing && !resetExisting) {
      return existing;
    }

    const progress: WalkthroughProgress = {
      allFiles: await this.getChangedFiles(info),
      presentedFiles: [],
      unidentifiedPresentations: 0,
    };
    this.progressByPrUrl.set(prUrl, progress);
    return progress;
  }

  private async getChangedFiles(info: WorktreeInfo): Promise<string[]> {
    try {
      const output = await gitExec(
        ['diff', '--name-only', `${info.baseRef}...${info.headRef}`],
        info.worktreePath,
      );
      return output
        .split(/\r?\n/)
        .map(file => this.normalizePresentedFilePath(file))
        .filter(Boolean);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`Unable to derive walkthrough file list: ${msg}`);
      return [];
    }
  }

  private isFileWalkthroughPhase(phase: string): boolean {
    return phase === 'walkthrough' || phase === 'lastFile';
  }

  private getSignaledFilePaths(input: { filePath?: unknown; filePaths?: unknown }): string[] {
    return [
      ...(typeof input.filePath === 'string' ? [input.filePath] : []),
      ...(Array.isArray(input.filePaths) ? input.filePaths.filter((filePath): filePath is string => typeof filePath === 'string') : []),
    ];
  }

  private isAdvancePrompt(prompt: string): boolean {
    return /\b(start(?: the)? walkthrough|continue(?: to the next file)?|next file)\b/i.test(prompt);
  }

  /**
   * Record a file the model claims to have just presented. Returns true if the
   * path could be matched to an entry in `progress.allFiles`, false otherwise
   * (so callers can fall back to an "unidentified presentation" counter).
   * Only canonical paths that exist in `allFiles` are pushed onto
   * `presentedFiles` — keeping that array a strict subset of `allFiles`.
   */
  private recordPresentedFile(progress: WalkthroughProgress, filePath: string): boolean {
    const normalizedPath = this.normalizePresentedFilePath(filePath);
    if (!normalizedPath) {
      return false;
    }

    const canonicalPath = this.findCanonicalFilePath(progress.allFiles, normalizedPath);
    if (!canonicalPath) {
      this.log.debug(`Presented walkthrough file is not in the changed-file list: ${filePath}`);
      return false;
    }
    if (!progress.presentedFiles.includes(canonicalPath)) {
      progress.presentedFiles.push(canonicalPath);
    }
    return true;
  }

  private normalizePresentedFilePath(filePath: string): string {
    return filePath
      .trim()
      .replace(/^[`'"]+|[`'"]+$/g, '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
  }

  private findCanonicalFilePath(allFiles: string[], filePath: string): string | undefined {
    if (allFiles.includes(filePath)) {
      return filePath;
    }
    const withoutDiffPrefix = filePath.replace(/^[ab]\//, '');
    if (allFiles.includes(withoutDiffPrefix)) {
      return withoutDiffPrefix;
    }
    // Suffix match: handles cases where the model passed a partial path or
    // bare basename (e.g. "walkthroughParticipant.ts" for
    // "packages/ai-reviewer/src/walkthroughParticipant.ts"). Only accept when
    // exactly one file in allFiles ends with this suffix, to avoid ambiguous
    // basename collisions ("index.ts", "package.json", etc.).
    const suffixMatches = allFiles.filter(
      file => file === withoutDiffPrefix || file.endsWith('/' + withoutDiffPrefix),
    );
    return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
  }

  private deriveFileWalkthroughPhase(phase: string, progress: WalkthroughProgress): string {
    if (phase === 'lastFile') {
      return phase;
    }
    if (phase !== 'walkthrough' || progress.allFiles.length === 0) {
      return phase;
    }
    return this.getRemainingFiles(progress) === 0 ? 'lastFile' : phase;
  }

  private getRemainingFiles(progress: WalkthroughProgress): number | undefined {
    if (progress.allFiles.length === 0) {
      return undefined;
    }
    const presented = new Set(progress.presentedFiles);
    const identifiedRemaining = progress.allFiles.filter(file => !presented.has(file)).length;
    // Subtract unidentified presentations as a coarse credit toward "we did
    // present something this turn, we just couldn't pin down which file."
    return Math.max(0, identifiedRemaining - progress.unidentifiedPresentations);
  }

  private extractPrUrl(
    prompt: string,
    context: vscode.ChatContext,
  ): string | undefined {
    // Try current prompt first
    const urlMatch = prompt.match(PR_URL_PATTERN);
    if (urlMatch) return urlMatch[0];

    // Check previous turns in history
    for (const turn of context.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        const historyMatch = turn.prompt.match(PR_URL_PATTERN);
        if (historyMatch) return historyMatch[0];
      }
    }

    return undefined;
  }
}
