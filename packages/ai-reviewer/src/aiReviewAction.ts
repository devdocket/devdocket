import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkItem, WorkCenterAction } from './types';
import { DEFAULT_REVIEW_PROMPT } from './defaultPrompt';

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
    } catch (err) {
      const message = err instanceof Error ? err.message : `Could not read custom prompt file "${customPath}"`;
      vscode.window.showWarningMessage(
        `AI Code Review: ${message} — using built-in prompt.`,
      );
      return DEFAULT_REVIEW_PROMPT;
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

    if (!this.isWithinWorkspace(resolvedUri.fsPath, folders)) {
      throw new Error(
        `Custom prompt path must be within the workspace. "${promptPath}" resolves outside all workspace folders.`,
      );
    }

    return resolvedUri;
  }

  private isWithinWorkspace(
    filePath: string,
    folders: readonly vscode.WorkspaceFolder[],
  ): boolean {
    const normalizedFile = path.normalize(filePath);
    return folders.some((folder) => {
      const normalizedFolder = path.normalize(folder.uri.fsPath);
      const prefix = normalizedFolder + path.sep;
      if (process.platform === 'win32') {
        return (
          normalizedFile.toLowerCase() === normalizedFolder.toLowerCase() ||
          normalizedFile.toLowerCase().startsWith(prefix.toLowerCase())
        );
      }
      return (
        normalizedFile === normalizedFolder ||
        normalizedFile.startsWith(prefix)
      );
    });
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

      const runtimeInstructions = `

## Important Instructions

**PR URL:** ${prUrl} — include a link to this PR in the review header.

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
