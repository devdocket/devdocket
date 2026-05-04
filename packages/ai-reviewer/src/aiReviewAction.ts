import * as vscode from 'vscode';
import { BasePrAction, sanitizePrUrl } from './basePrAction';
import { DEFAULT_REVIEW_PROMPT } from './defaultPrompt';
import { fenceDiff } from './diffFence';
import { truncateToolContent } from './toolUtils';
import { gitExec } from './tools/gitUtils';
import { AdoPrClient } from './adoPrClient';
import { parseAdoPrUrl } from './prUrl';
import type { RepoManager, WorktreeInfo } from './repoManager';
import type { WorkItem } from './types';

// Re-export sanitizePrUrl for backward compatibility (tests import it from here)
export { sanitizePrUrl };

/** Maximum tool-use loop iterations for the tool-enabled review flow. */
const MAX_TOOL_ITERATIONS = 15;

export class AiReviewAction extends BasePrAction {
  readonly id = 'ai-reviewer.review';
  readonly label = 'AI Code Review';

  protected readonly configSection = 'devDocketAiReview';
  protected readonly defaultPromptContent = DEFAULT_REVIEW_PROMPT;
  protected readonly progressTitle = 'AI Code Review';
  protected readonly outputHeader = '# AI Code Review\n\n';
  protected readonly confirmationMessage =
    'AI Code Review will send the PR diff to the language model for analysis and may allow the model to access additional repository context through tools, such as file contents, directory listings, and git history/diffs. Continue?';

  constructor(
    private readonly repoManager: RepoManager,
    private readonly log: vscode.LogOutputChannel,
  ) {
    super();
  }

  protected getRuntimeInstructions(safePrUrl: string): string {
    return `

## Important Instructions

**PR URL:** ${safePrUrl} — include a link to this PR in the review header.

**File paths and line numbers:** When commenting on specific issues, always include the file path and line number(s) from the diff so the reader can locate the code immediately. Use the format \`path/to/file.ts:42\` for single lines or \`path/to/file.ts:42-50\` for ranges. If a finding spans multiple files, list each location separately.`;
  }

  protected async doWork(
    item: WorkItem,
    progress: vscode.Progress<{ message?: string }>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    progress.report({ message: 'Fetching PR diff...' });
    const adoParts = parseAdoPrUrl(item.url!);
    let adoDiffWasSynthetic = false;
    let diff: string | undefined;
    if (adoParts) {
      try {
        const adoDiff = await new AdoPrClient().fetchDiffResult(adoParts);
        diff = adoDiff?.diff;
        adoDiffWasSynthetic = adoDiff?.synthetic ?? false;
      } catch (err) {
        console.error(`${this.progressTitle}: failed to fetch diff:`, err);
        vscode.window.showWarningMessage(`${this.progressTitle}: Failed to fetch PR diff`);
        return;
      }
    } else {
      diff = await this.fetchDiff(item.url!);
    }
    if (diff === undefined) {
      if (adoParts) {
        vscode.window.showWarningMessage('AI Code Review: Azure DevOps authentication is required to fetch the PR diff.');
      }
      return;
    }
    if (token.isCancellationRequested) return;

    // Check model availability before expensive worktree preparation
    const models = await vscode.lm.selectChatModels();
    if (models.length === 0) {
      vscode.window.showWarningMessage(
        `${this.progressTitle}: No language model available. Install GitHub Copilot.`,
      );
      return;
    }

    // Prepare worktree (best-effort — review falls back to diff-only)
    progress.report({ message: 'Preparing repository...' });
    let worktreeInfo: WorktreeInfo | undefined;
    try {
      worktreeInfo = await this.repoManager.ensureWorktree(item.url!);
      this.log.info('Worktree ready for code review');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`Worktree preparation failed (continuing with diff only): ${msg}`);
    }

    if (worktreeInfo && adoParts) {
      progress.report({ message: 'Preparing Azure DevOps diff...' });
      try {
        const gitDiff = await gitExec(
          ['diff', '--no-color', `${worktreeInfo.baseRef}...${worktreeInfo.headRef}`],
          worktreeInfo.worktreePath,
        );
        diff = gitDiff;
        adoDiffWasSynthetic = false;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`Failed to build ADO git diff (using API diff fallback): ${msg}`);
      }
    }

    if (adoParts && adoDiffWasSynthetic) {
      vscode.window.showWarningMessage(
        'AI Code Review: Azure DevOps returned only change metadata and a full local git diff could not be prepared, so a useful AI review cannot be generated.',
      );
      return;
    }

    if (adoParts && diff.length === 0) {
      vscode.window.showInformationMessage('AI Code Review: No Azure DevOps PR changes were detected.');
      return;
    }

    if (token.isCancellationRequested) return;

    progress.report({ message: 'Analyzing changes...' });

    let result: string | undefined;
    if (worktreeInfo) {
      result = await this.analyzeWithTools(diff, item.url!, worktreeInfo, models[0], token);
    } else {
      result = await this.analyzeWithAi(diff, item.url!, token, models[0]);
    }
    if (!result || token.isCancellationRequested) return;

    const doc = await vscode.workspace.openTextDocument({
      content: result,
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: false });

    if (adoParts && !token.isCancellationRequested) {
      await this.offerPostAdoReviewSummary(adoParts, result);
    }
  }

  private formatAdoReviewComment(result: string): string {
    const maxLength = 60_000;
    if (result.length <= maxLength) {
      return result;
    }
    const footer = '\n\n> Review truncated for Azure DevOps comment length. The full review remains open in the editor.';
    return `${result.slice(0, maxLength - footer.length)}${footer}`;
  }

  private async offerPostAdoReviewSummary(
    adoParts: NonNullable<ReturnType<typeof parseAdoPrUrl>>,
    result: string,
  ): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      'AI Code Review: Post this review summary as an Azure DevOps PR comment?',
      { modal: true },
      'Post Comment',
    );
    if (choice !== 'Post Comment') {
      return;
    }

    try {
      await new AdoPrClient().postThread(adoParts, { content: this.formatAdoReviewComment(result) });
      vscode.window.showInformationMessage('AI Code Review: Posted review summary to Azure DevOps.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to post ADO review summary: ${msg}`);
      vscode.window.showWarningMessage(`AI Code Review: Failed to post Azure DevOps comment — ${msg}`);
    }
  }

  /**
   * Tool-enabled analysis: gives the model access to the full repository
   * via LM tools (readFile, searchCode, getDiff, etc.).
   */
  async analyzeWithTools(
    diff: string,
    prUrl: string,
    worktreeInfo: WorktreeInfo,
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken,
  ): Promise<string | undefined> {
    try {
      this.log.info(`Selected model: ${model.id}`);

      const reviewPrompt = await this.getReviewPrompt();
      const safePrUrl = sanitizePrUrl(prUrl);
      const runtimeInstructions = this.getRuntimeInstructions(safePrUrl);

      // Build repo context block with tool instructions
      const repoContext = this.buildRepoContext(worktreeInfo);

      const maxDiffLength = 50_000;
      const isDiffTruncated = diff.length > maxDiffLength;
      let truncationNote = '';
      let truncationInstructions = '';

      if (isDiffTruncated) {
        truncationNote =
          '\n\n> ⚠️ **Note:** The PR diff was truncated. The model was instructed to examine each file individually.\n';

        // Get the full list of changed files so the model knows what to review
        let fileList = '';
        try {
          fileList = await gitExec(
            ['diff', '--name-status', `${worktreeInfo.baseRef}...${worktreeInfo.headRef}`],
            worktreeInfo.worktreePath,
          );
        } catch (err) {
          this.log.warn(`Failed to get file list: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Cap the file list to avoid blowing the context budget on very large PRs
        const maxFileListLength = 5_000;
        let displayList = fileList;
        if (fileList.length > maxFileListLength) {
          const lines = fileList.split('\n');
          let truncated = '';
          for (const line of lines) {
            if (truncated.length + line.length + 1 > maxFileListLength) {
              truncated += `\n... and more files (${lines.length} total — use devdocket-getDiff for the full list)`;
              break;
            }
            truncated += (truncated ? '\n' : '') + line;
          }
          displayList = truncated;
        }

        truncationInstructions = `

## ⚠️ Diff Truncation — Autonomous File-by-File Review Required

The PR diff below has been truncated (${diff.length.toLocaleString()} chars total, only first ${maxDiffLength.toLocaleString()} shown).
**You MUST review ALL changed files, not just what's visible in the truncated diff.**

**Procedure:**
1. Use the file list below to identify every changed file.
2. For EACH file, call **devdocket-getFileDiff** with \`worktreePath: "${worktreeInfo.worktreePath}"\`, \`baseRef: "${worktreeInfo.baseRef}"\`, \`headRef: "${worktreeInfo.headRef}"\`, and the file's path.
3. Review each file's diff thoroughly using the review framework below.
4. Produce a single, complete review covering ALL files — do not ask the user which files to focus on.

**Do NOT:**
- Ask the user what to focus on or which files to review
- Produce only a summary and wait for direction
- Skip files because the inline diff was truncated

**Changed files in this PR:**
\`\`\`
${displayList || '(file list unavailable — use devdocket-getDiff to get the stat summary)'}
\`\`\`

`;
      }

      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(
          `${runtimeInstructions}${repoContext}${truncationInstructions}${reviewPrompt}\n\n${fenceDiff(diff.slice(0, maxDiffLength))}`,
        ),
      ];

      // Gather registered LM tools for repo exploration
      const tools = this.gatherTools();
      this.log.info(`Gathered ${tools.length} LM tools for review`);

      // Tool-use loop
      const loopMessages = [...messages];
      let result = this.outputHeader;
      let iterations = 0;

      while (!token.isCancellationRequested && iterations < MAX_TOOL_ITERATIONS) {
        iterations++;
        this.log.debug(`Tool-use loop iteration ${iterations}`);

        let chatResponse: vscode.LanguageModelChatResponse;
        try {
          chatResponse = await model.sendRequest(
            loopMessages,
            tools.length > 0 ? { tools } : {},
            token,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.error(`model.sendRequest failed on iteration ${iterations}: ${msg}`);
          if (iterations === 1) {
            vscode.window.showErrorMessage(`${this.progressTitle}: Analysis failed`);
            return undefined;
          }
          result += '\n\n> ⚠️ **Warning:** AI analysis ended early because a follow-up model request failed. The review above may be incomplete.\n';
          break;
        }

        let hasToolCalls = false;
        const assistantParts: (
          | vscode.LanguageModelTextPart
          | vscode.LanguageModelToolCallPart
        )[] = [];
        const toolResults: Array<{
          callId: string;
          content: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[];
        }> = [];

        for await (const part of chatResponse.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            result += part.value;
            assistantParts.push(part);
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            hasToolCalls = true;
            assistantParts.push(part);
            this.log.debug(`Tool call: ${part.name} (callId: ${part.callId})`);

            try {
              const toolResult = await vscode.lm.invokeTool(
                part.name,
                { input: part.input, toolInvocationToken: undefined },
                token,
              );

              // Truncate large tool results to prevent context overflow
              const content = truncateToolContent(toolResult.content);
              toolResults.push({ callId: part.callId, content });
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

        this.log.debug(
          `Iteration ${iterations}: ${assistantParts.length} parts, ${toolResults.length} tool results`,
        );

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
          this.log.info(`No tool calls in iteration ${iterations} — analysis complete`);
          break;
        }
      }

      if (iterations >= MAX_TOOL_ITERATIONS) {
        this.log.warn(`Reached max tool iterations (${MAX_TOOL_ITERATIONS})`);
        result += `\n\n> ⚠️ **Note:** This review stopped after reaching the maximum number of tool iterations (${MAX_TOOL_ITERATIONS}). The investigation may be incomplete.\n`;
      }

      return result + truncationNote;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`${this.progressTitle}: analysis failed: ${msg}`);
      vscode.window.showErrorMessage(`${this.progressTitle}: Analysis failed`);
      return undefined;
    }
  }

  /** Build a prompt section describing repository context and available tools. */
  private buildRepoContext(info: WorktreeInfo): string {
    return `

## Repository Context

You have access to the full repository for this PR, not just the diff. Use the tools below
to explore callers of modified functions, verify test coverage, understand architectural
patterns, and cross-reference related files.

- **Worktree path:** ${info.worktreePath}
- **Org/Repo:** ${info.org}/${info.repo}
- **PR number:** ${info.prNumber}
- **Head ref:** ${info.headRef}
- **Base ref:** ${info.baseRef}

### Available Tools (commonly used — additional devdocket-* tools may also be available)

- **devdocket-readFile** — Read the full contents of a file. Pass \`worktreePath: "${info.worktreePath}"\` and a relative \`filePath\`.
- **devdocket-listDirectory** — List files and directories. Pass \`worktreePath: "${info.worktreePath}"\` and optionally \`dirPath\`.
- **devdocket-getDiff** — Get the full unified diff. Pass \`worktreePath: "${info.worktreePath}"\`, \`baseRef: "${info.baseRef}"\`, \`headRef: "${info.headRef}"\`.
- **devdocket-getFileDiff** — Get diff for a specific file. Same refs plus a \`filePath\`.
- **devdocket-searchCode** — Search the codebase with git grep. Pass \`worktreePath: "${info.worktreePath}"\`, \`pattern\`, and optionally \`fileGlob\`.
- **devdocket-gitLog** — Get recent commit history. Pass \`worktreePath: "${info.worktreePath}"\` and optionally \`filePath\` and \`maxCount\`.

**Use tools proactively** to verify your findings. Before flagging an issue, use devdocket-searchCode
to check callers and consumers. Use devdocket-readFile to examine test coverage for changed code.
Cross-reference with related files to understand the impact of changes.

**Critical — file paths:** When calling tools with file paths, use the exact paths from the diff output
(the paths shown after \`a/\` and \`b/\` in diff headers).

`;
  }

  /** Collect registered devdocket-* LM tools for the model to use. */
  private gatherTools(): {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[] {
    return vscode.lm.tools
      .filter(
        (t: vscode.LanguageModelToolInformation) =>
          t.name.startsWith('devdocket-') && t.inputSchema,
      )
      .map((t: vscode.LanguageModelToolInformation) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
  }
}
