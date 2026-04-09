import * as vscode from 'vscode';
import type { WorkItem, WorkCenterAction } from './types';
import { DEFAULT_REVIEW_PROMPT } from './defaultPrompt';

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

export class AiReviewAction implements WorkCenterAction {
  readonly id = 'ai-reviewer.review';
  readonly label = 'AI Code Review';

  canRun(item: WorkItem): boolean {
    if (!item.url) return false;
    return this.isPrUrl(item.url);
  }

  isPrUrl(url: string): boolean {
    return this.parseGitHubPrUrl(url) !== undefined;
  }

  /** Parse a GitHub PR URL, returning repo and PR number or undefined. */
  parseGitHubPrUrl(url: string): { repo: string; prNumber: string } | undefined {
    const match = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:$|[\/?#])/);
    if (!match) return undefined;
    return { repo: match[1], prNumber: match[2] };
  }

  async run(item: WorkItem): Promise<void> {
    if (!item.url) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'AI Code Review',
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
          'AI Code Review will send the PR diff to the language model for analysis. Continue?',
          { modal: true },
          'Continue',
        );
        if (proceed !== 'Continue' || token.isCancellationRequested) return;

        progress.report({ message: 'Analyzing changes...' });

        const review = await this.analyzeWithAi(diff, item.url!, token);
        if (!review || token.isCancellationRequested) return;

        const doc = await vscode.workspace.openTextDocument({
          content: review,
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
      console.error('AI Review: failed to fetch diff:', err);
      vscode.window.showWarningMessage('AI Code Review: Failed to fetch PR diff');
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
      vscode.window.showWarningMessage(`AI Code Review: GitHub API returned ${response.status}`);
      return undefined;
    }
    return response.text();
  }

  /** Load the review prompt, using a custom file if configured, otherwise the built-in default. */
  async getReviewPrompt(): Promise<string> {
    const config = vscode.workspace.getConfiguration('workcenterAiReview');
    const customPath = config.get<string>('customPromptPath', '');
    if (!customPath) {
      return DEFAULT_REVIEW_PROMPT;
    }

    try {
      const uri = this.resolvePromptUri(customPath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder('utf-8').decode(bytes).trim();
      if (!content) {
        vscode.window.showWarningMessage(
          'AI Code Review: Custom prompt file is empty — using built-in prompt.',
        );
        return DEFAULT_REVIEW_PROMPT;
      }
      return content;
    } catch {
      vscode.window.showWarningMessage(
        `AI Code Review: Could not read custom prompt file "${customPath}" — using built-in prompt.`,
      );
      return DEFAULT_REVIEW_PROMPT;
    }
  }

  /** Resolve a prompt path to a URI. Absolute paths are used directly; relative paths resolve against the single workspace folder. */
  resolvePromptUri(promptPath: string): vscode.Uri {
    if (this.isAbsolutePath(promptPath)) {
      return vscode.Uri.file(promptPath);
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No workspace folder open — cannot resolve relative prompt path.');
    }
    if (folders.length > 1) {
      throw new Error(
        'Multiple workspace folders — use an absolute path for the custom prompt.',
      );
    }
    return vscode.Uri.joinPath(folders[0].uri, promptPath);
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
        vscode.window.showWarningMessage('AI Code Review: No language model available. Install GitHub Copilot.');
        return undefined;
      }

      const maxDiffLength = 50000;
      let truncationNote = '';
      if (diff.length > maxDiffLength) {
        truncationNote = '\n\n> ⚠️ **Note:** The PR diff was truncated to the first 50,000 characters. Some changes may not be covered in this review.\n';
      }

      const reviewPrompt = await this.getReviewPrompt();

      const safePrUrl = sanitizePrUrl(prUrl);

      const runtimeInstructions = `

## Important Instructions

**PR URL:** ${safePrUrl} — include a link to this PR in the review header.

**File paths and line numbers:** When commenting on specific issues, always include the file path and line number(s) from the diff so the reader can locate the code immediately. Use the format \`path/to/file.ts:42\` for single lines or \`path/to/file.ts:42-50\` for ranges. If a finding spans multiple files, list each location separately.`;

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

      let result = '# AI Code Review\n\n';
      for await (const chunk of response.text) {
        result += chunk;
      }
      return result + truncationNote;
    } catch (err) {
      console.error('AI Review: analysis failed:', err);
      vscode.window.showErrorMessage('AI Code Review: Analysis failed');
      return undefined;
    }
  }
}
