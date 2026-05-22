import * as vscode from 'vscode';
import { combineSignals, createAbortError } from '@devdocket/shared';
import type { WorkItem, DevDocketAction } from './types';
import { parseAdoPrUrl, parsePullRequestUrl, parsePrUrl } from './prUrl';
import { AdoPrClient } from './adoPrClient';
import { getGitHubSession } from './auth';
import { confirmAiUsage } from './confirmAiUsage';
import { fenceDiff } from './diffFence';
import { sanitizePrUrl } from './promptSanitization';

export { sanitizePrUrl };

/**
 * Base class for PR-based AI actions (code review, walkthrough, etc.).
 * Subclasses provide identity, confirmation message, and implement doWork()
 * with their specific logic. Shared behavior (URL validation, confirmation
 * prompt, progress notification) lives here.
 */
export abstract class BasePrAction implements DevDocketAction {
  abstract readonly id: string;
  abstract readonly label: string;

  protected abstract readonly progressTitle: string;
  protected abstract readonly confirmationMessage: string;

  // Override in subclasses that use inline AI analysis (getReviewPrompt / analyzeWithAi)
  protected readonly configSection: string = '';
  protected readonly defaultPromptContent: string = '';
  protected readonly outputHeader: string = '';
  protected getRuntimeInstructions(_safePrUrl: string): string { return ''; }

  /**
   * Subclass-specific work executed inside the progress notification
   * after the user has confirmed AI usage.
   */
  protected abstract doWork(
    item: WorkItem,
    progress: vscode.Progress<{ message?: string }>,
    token: vscode.CancellationToken,
  ): Promise<void>;

  canRun(item: WorkItem): boolean {
    if (!item.url) return false;
    return this.isPrUrl(item.url);
  }

  isPrUrl(url: string): boolean {
    return parsePullRequestUrl(url) !== undefined;
  }

  /** Parse a GitHub PR URL, returning repo and PR number or undefined. */
  parseGitHubPrUrl(url: string): { repo: string; prNumber: string } | undefined {
    const parts = parsePrUrl(url);
    if (!parts) return undefined;
    return { repo: `${parts.org}/${parts.repo}`, prNumber: parts.prNumber };
  }

  async run(item: WorkItem): Promise<void> {
    if (!this.canRun(item)) return;

    if (!await confirmAiUsage(this.confirmationMessage)) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: this.progressTitle,
        cancellable: true,
      },
      async (progress, token) => {
        await this.doWork(item, progress, token);
      },
    );
  }

  async fetchDiff(url: string, token?: vscode.CancellationToken): Promise<string | undefined> {
    try {
      const github = this.parseGitHubPrUrl(url);
      if (github) {
        return await this.fetchGitHubDiff(github.repo, github.prNumber, token);
      }

      const ado = parseAdoPrUrl(url);
      if (ado) {
        const abortController = new AbortController();
        const cancelListener = token?.onCancellationRequested?.(() => abortController.abort());
        try {
          if (token?.isCancellationRequested) {
            throw createAbortError();
          }
          return await new AdoPrClient().fetchDiff(ado, { interactive: true, signal: abortController.signal });
        } finally {
          cancelListener?.dispose();
        }
      }

      return undefined;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      console.error(`${this.progressTitle}: failed to fetch diff:`, err);
      vscode.window.showWarningMessage(`${this.progressTitle}: Failed to fetch PR diff`);
      return undefined;
    }
  }

  private async fetchGitHubDiff(
    repo: string,
    prNumber: string,
    token?: vscode.CancellationToken,
  ): Promise<string | undefined> {
    const abortController = new AbortController();
    const cancelListener = token?.onCancellationRequested?.(() => abortController.abort());
    try {
      const session = await getGitHubSession({ interactive: true, signal: abortController.signal });
      if (!session) {
        vscode.window.showWarningMessage(
          `${this.progressTitle}: GitHub authentication is required to fetch the PR diff.`,
        );
        return undefined;
      }

      const response = await fetch(
        `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
        {
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
            Accept: 'application/vnd.github.diff',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: combineSignals(abortController.signal, 30_000),
        },
      );

      if (!response.ok) {
        vscode.window.showWarningMessage(`${this.progressTitle}: GitHub API returned ${response.status}`);
        return undefined;
      }
      return response.text();
    } finally {
      cancelListener?.dispose();
    }
  }

  /** Load the prompt, using a custom file if configured, otherwise the built-in default. */
  async getReviewPrompt(): Promise<string> {
    const config = vscode.workspace.getConfiguration(this.configSection);
    const customPath = config.get<string>('customPromptPath', '');
    if (!customPath) {
      return this.defaultPromptContent;
    }

    try {
      const uri = this.resolvePromptUri(customPath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder('utf-8').decode(bytes).trim();
      if (!content) {
        vscode.window.showWarningMessage(
          `${this.progressTitle}: Custom prompt file is empty — using built-in prompt.`,
        );
        return this.defaultPromptContent;
      }
      return content;
    } catch (err) {
      const message =
        err instanceof Error
          ? `Could not read custom prompt file "${customPath}": ${err.message}`
          : `Could not read custom prompt file "${customPath}"`;
      vscode.window.showWarningMessage(
        `${this.progressTitle}: ${message} — using built-in prompt.`,
      );
      return this.defaultPromptContent;
    }
  }

  /** Resolve a prompt path to a URI, validating it stays within the workspace. */
  resolvePromptUri(promptPath: string): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No workspace folder open — cannot resolve custom prompt path.');
    }

    let resolvedUri: vscode.Uri;

    if (this.isAbsolutePath(promptPath)) {
      resolvedUri = vscode.Uri.file(promptPath);
    } else {
      if (folders.length > 1) {
        throw new Error(
          'Multiple workspace folders — use an absolute path for the custom prompt.',
        );
      }
      resolvedUri = vscode.Uri.joinPath(folders[0].uri, promptPath);
    }

    if (!vscode.workspace.getWorkspaceFolder(resolvedUri)) {
      throw new Error(
        `Custom prompt path must be within the workspace. "${promptPath}" resolves outside all workspace folders.`,
      );
    }

    return resolvedUri;
  }

  private isAbsolutePath(p: string): boolean {
    // Unix absolute or Windows drive-letter absolute (e.g. C:\...)
    return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
  }

  async analyzeWithAi(diff: string, prUrl: string, token: vscode.CancellationToken, preselectedModel?: vscode.LanguageModelChat): Promise<string | undefined> {
    try {
      let model = preselectedModel;
      if (!model) {
        const models = await vscode.lm.selectChatModels();
        if (models.length === 0) {
          vscode.window.showWarningMessage(`${this.progressTitle}: No language model available. Install GitHub Copilot.`);
          return undefined;
        }
        model = models[0];
      }

      const maxDiffLength = 50000;
      let truncationNote = '';
      if (diff.length > maxDiffLength) {
        truncationNote = '\n\n> ⚠️ **Note:** The PR diff was truncated to the first 50,000 characters. Some changes may not be covered.\n';
      }

      const reviewPrompt = await this.getReviewPrompt();

      const safePrUrl = sanitizePrUrl(prUrl);

      const runtimeInstructions = this.getRuntimeInstructions(safePrUrl);

      const messages = [
        vscode.LanguageModelChatMessage.User(
          `${runtimeInstructions}${reviewPrompt}\n\n${fenceDiff(diff.slice(0, maxDiffLength))}`
        ),
      ];

      const response = await model.sendRequest(messages, {}, token);

      let result = this.outputHeader;
      for await (const chunk of response.text) {
        result += chunk;
      }
      return result + truncationNote;
    } catch (err) {
      console.error(`${this.progressTitle}: analysis failed:`, err);
      vscode.window.showErrorMessage(`${this.progressTitle}: Analysis failed`);
      return undefined;
    }
  }
}
