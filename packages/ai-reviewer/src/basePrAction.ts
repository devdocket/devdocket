import * as vscode from 'vscode';
import type { WorkItem, WorkCenterAction } from './types';
import { parsePrUrl } from './prUrl';

/**
 * Validate and sanitize a PR URL before interpolating it into an LLM prompt.
 * Prevents prompt injection via crafted URL strings.
 */
export function sanitizePrUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '(URL unavailable)';
    }
    // Strip newlines, carriage returns, and backticks that could break prompt structure
    return parsed.href.replace(/[\r\n`]/g, '');
  } catch {
    return '(URL unavailable)';
  }
}

/**
 * Base class for PR-based AI actions (code review, walkthrough, etc.).
 * Subclasses provide prompt content, labels, and runtime instructions.
 */
export abstract class BasePrAction implements WorkCenterAction {
  abstract readonly id: string;
  abstract readonly label: string;

  protected abstract readonly configSection: string;
  protected abstract readonly defaultPromptContent: string;
  protected abstract readonly progressTitle: string;
  protected abstract readonly outputHeader: string;
  protected abstract readonly confirmationMessage: string;

  protected abstract getRuntimeInstructions(safePrUrl: string): string;

  canRun(item: WorkItem): boolean {
    if (!item.url) return false;
    return this.isPrUrl(item.url);
  }

  isPrUrl(url: string): boolean {
    return this.parseGitHubPrUrl(url) !== undefined;
  }

  /** Parse a GitHub PR URL, returning repo and PR number or undefined. */
  parseGitHubPrUrl(url: string): { repo: string; prNumber: string } | undefined {
    const parts = parsePrUrl(url);
    if (!parts) return undefined;
    return { repo: `${parts.org}/${parts.repo}`, prNumber: parts.prNumber };
  }

  async run(item: WorkItem): Promise<void> {
    if (!item.url) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: this.progressTitle,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Fetching PR diff...' });

        const diff = await this.fetchDiff(item.url!);
        if (!diff) {
          return;
        }

        if (token.isCancellationRequested) return;

        const proceed = await vscode.window.showWarningMessage(
          this.confirmationMessage,
          { modal: true },
          'Continue',
        );
        if (proceed !== 'Continue' || token.isCancellationRequested) return;

        progress.report({ message: 'Analyzing changes...' });

        const result = await this.analyzeWithAi(diff, item.url!, token);
        if (!result || token.isCancellationRequested) return;

        const doc = await vscode.workspace.openTextDocument({
          content: result,
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: false });
      },
    );
  }

  async fetchDiff(url: string): Promise<string | undefined> {
    try {
      const parsed = this.parseGitHubPrUrl(url);
      if (parsed) {
        return await this.fetchGitHubDiff(parsed.repo, parsed.prNumber);
      }
      return undefined;
    } catch (err) {
      console.error(`${this.progressTitle}: failed to fetch diff:`, err);
      vscode.window.showWarningMessage(`${this.progressTitle}: Failed to fetch PR diff`);
      return undefined;
    }
  }

  private async fetchGitHubDiff(repo: string, prNumber: string): Promise<string | undefined> {
    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: true,
    });
    if (!session) {
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
      },
    );

    if (!response.ok) {
      vscode.window.showWarningMessage(`${this.progressTitle}: GitHub API returned ${response.status}`);
      return undefined;
    }
    return response.text();
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

  async analyzeWithAi(diff: string, prUrl: string, token: vscode.CancellationToken): Promise<string | undefined> {
    try {
      let models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
      if (models.length === 0) {
        models = await vscode.lm.selectChatModels();
      }
      if (models.length === 0) {
        vscode.window.showWarningMessage(`${this.progressTitle}: No language model available. Install GitHub Copilot.`);
        return undefined;
      }

      const maxDiffLength = 50000;
      let truncationNote = '';
      if (diff.length > maxDiffLength) {
        truncationNote = '\n\n> ⚠️ **Note:** The PR diff was truncated to the first 50,000 characters. Some changes may not be covered.\n';
      }

      const reviewPrompt = await this.getReviewPrompt();

      const safePrUrl = sanitizePrUrl(prUrl);

      const runtimeInstructions = this.getRuntimeInstructions(safePrUrl);

      const model = models[0];
      const messages = [
        vscode.LanguageModelChatMessage.User(
          `${runtimeInstructions}${reviewPrompt}

\`\`\`\`diff
${diff.slice(0, maxDiffLength)}
\`\`\`\``
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
