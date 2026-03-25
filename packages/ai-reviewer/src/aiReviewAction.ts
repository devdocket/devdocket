import * as vscode from 'vscode';
import type { WorkItem, WorkCenterAction } from './types';

export class AiReviewAction implements WorkCenterAction {
  readonly id = 'ai-reviewer.review';
  readonly label = 'AI Code Review';

  canRun(item: WorkItem): boolean {
    if (!item.url) return false;
    return this.isPrUrl(item.url);
  }

  isPrUrl(url: string): boolean {
    // GitHub PR: https://github.com/owner/repo/pull/123
    if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:$|[\/?#])/.test(url)) return true;
    return false;
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

        const review = await this.analyzeWithAi(diff, token);
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
      const githubMatch = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
      if (githubMatch) {
        return await this.fetchGitHubDiff(githubMatch[1], githubMatch[2]);
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
      createIfNone: false,
    });
    if (!session) {
      vscode.window.showWarningMessage('AI Code Review: Please sign in to GitHub.');
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

  async analyzeWithAi(diff: string, token: vscode.CancellationToken): Promise<string | undefined> {
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

      const model = models[0];
      const messages = [
        vscode.LanguageModelChatMessage.User(
          `You are a code reviewer. Analyze this PR diff and provide a review focusing on:
1. Bugs and logic errors
2. Security vulnerabilities
3. Performance issues
4. Missing error handling

Be concise. Only flag genuine issues, not style preferences.

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
